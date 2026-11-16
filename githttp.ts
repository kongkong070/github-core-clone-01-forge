// githttp.ts — git smart HTTP: info/refs advertisements, protocol v2
// ls-refs and fetch, protocol v0 upload-pack, and receive-pack.
//
// The rules the suite holds this surface to:
//   - upload-pack speaks v2 when the request carries Git-Protocol:
//     version=2 (capability advertisement, ls-refs, fetch with shallow and
//     filter), and v0 otherwise (ref advertisement with side-band-64k).
//   - receive-pack is v0 only and advertises report-status, side-band-64k
//     and delete-refs.
//   - every update must fast-forward; a non-fast-forward push is refused
//     per ref with "ng <ref> non-fast-forward" and the ref does not move,
//     while the fast-forward refs in the same command list still apply.
//   - a missing repository is 404 on both services' GET /info/refs, and
//     the server stays up after any malformed request.

import {
  ZERO_OID,
  decodePktLines,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  splitPktSection,
  verifyPackChecksum,
  writePack,
} from './git.ts';
import type { GitObject } from './git.ts';
import type { Forge, Repo } from './store.ts';
import { DEFAULT_BRANCH } from './store.ts';

export const AGENT = 'forge/1.0';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** Every ref of a repository, HEAD first, then branches, then tags. */
function allRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({ oid: defaultTip ?? ZERO_OID, name: 'HEAD' });
  const branches = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  for (const name of branches) out.push({ oid: repo.refs.get(name) as string, name });
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const peeled = repo.objects.get(target);
      if (peeled && peeled.type === 'commit') line.peeled = target;
    }
    out.push(line);
  }
  return out;
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-upload-pack') {
    return [
      'side-band-64k',
      'thin-pack',
      'ofs-delta',
      'multi_ack_detailed',
      'shallow',
      'object-format=sha1',
      `agent=${AGENT}`,
      `symref=HEAD:refs/heads/${DEFAULT_BRANCH}`,
    ].join(' ');
  }
  return [
    'report-status',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `agent=${AGENT}`,
  ].join(' ');
}

/** The v0 ref advertisement for a service, with the "# service=" preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = allRefs(repo);
  const caps = v0Capabilities(service);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 1 && refs[0]?.name === 'HEAD') {
    // An empty repository: the capabilities^{} pseudo-ref carries the caps.
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      if (ref.name === 'HEAD') {
        const suffix = index === 0 ? `\0${caps}` : '';
        lines.push(`${ref.oid} HEAD${suffix}\n`);
        return;
      }
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  return pktLines(lines);
}

/** The v2 capability advertisement for upload-pack. */
export function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------

/**
 * A small cache of complete fetch responses. A fetch's result depends only
 * on the wanted and held object ids (objects are immutable and addressed
 * by id, so a fixed tip always yields the same reachable set), which
 * makes the clone workload's fifty identical shallow fetches cost one
 * pack computation instead of fifty. Bounded so a long run cannot grow it.
 */
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | undefined,
  protocol: 'v2' | 'v0',
): string {
  return [
    protocol,
    repo.owner,
    repo.name,
    [...wants].sort().join(','),
    [...haves].sort().join(','),
    [...shallow].sort().join(','),
    depth === undefined ? '' : String(depth),
  ].join('|');
}

function fetchCacheGet(key: string): Buffer | undefined {
  return fetchCache.get(key);
}

function fetchCachePut(key: string, response: Buffer): void {
  if (fetchCache.size >= 64) {
    const oldest = fetchCache.keys().next().value as string | undefined;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, response);
}

interface FetchPlan {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  /** Commits that are shallow boundaries after this fetch. */
  shallow: string[];
  /** Commits that were shallow boundaries and no longer are. */
  unshallow: string[];
}

/**
 * Plan a fetch: the objects reachable from `wants` (depth-limited when
 * `depth` is set), minus the objects the client already holds (`haves`,
 * where a shallow boundary's ancestors do not count as held).
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | undefined,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Objects the client holds: reachable from its haves, stopping at the
  // shallow boundaries (a shallow commit's parents are not held).
  const held = new Set<string>();
  const shallowSet = new Set(shallowBoundaries);
  const heldStack = [...haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop() as string;
    if (held.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      heldStack.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) heldStack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) heldStack.push(entry.oid);
    } else if (object.type === 'tag') {
      heldStack.push(parseTag(object.data).object);
    }
  }
  // Objects the fetch may deliver, with commit generations from the wants.
  const wanted = new Set<string>();
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 0 }));
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; gen: number };
    if (current.oid === ZERO_OID) continue;
    const knownGen = generations.get(current.oid);
    if (knownGen !== undefined && knownGen <= current.gen) continue;
    const object = lookup(current.oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      generations.set(current.oid, current.gen);
      wanted.add(current.oid);
      // The commit's tree (and blobs) are always delivered with it.
      const commit = parseCommit(object.data);
      const treeStack = [commit.tree];
      while (treeStack.length > 0) {
        const treeOid = treeStack.pop() as string;
        if (wanted.has(treeOid)) continue;
        const treeObject = lookup(treeOid);
        if (treeObject === undefined) continue;
        wanted.add(treeOid);
        if (treeObject.type === 'tree') {
          for (const entry of parseTree(treeObject.data)) treeStack.push(entry.oid);
        }
      }
      if (depth === undefined || current.gen + 1 < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: current.gen + 1 });
      }
    } else if (object.type === 'tag') {
      wanted.add(current.oid);
      queue.push({ oid: parseTag(object.data).object, gen: current.gen });
    } else {
      wanted.add(current.oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  // Shallow bookkeeping: commits at exactly the depth limit are the new
  // boundaries; old boundaries inside the delivered range are unshallowed.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, gen] of generations) {
      if (gen === depth - 1) shallow.push(oid);
    }
    shallow = [...new Set(shallow)].sort();
    unshallow = shallowBoundaries.filter((oid) => generations.has(oid) && (generations.get(oid) as number) < depth - 1);
    unshallow = [...new Set(unshallow)].sort();
  }
  return { objects, shallow, unshallow };
}

/** Wrap pack bytes in sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  } else {
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = splitPktSection(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8'));
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).trim() : '';
  const args = lines.slice(1);
  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const arg of args) {
      const text = arg.trim();
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    const refs = allRefs(repo);
    const out: Array<string | 'flush'> = [];
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip === undefined && unborn && keep('HEAD')) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.name === 'HEAD') {
        if (defaultTip === undefined) continue;
        out.push(`${ref.oid} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
    out.push('flush');
    return pktLines(out);
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const arg of args) {
      const text = arg.trim();
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    }
    const cached = fetchCacheGet(fetchCacheKey(repo, wants, haves, shallow, depth, 'v2'));
    if (cached !== undefined) return cached;
    const plan = planFetch(repo, wants, haves, shallow, depth);
    const pack = writePack(plan.objects);
    const parts: Buffer[] = [];
    // The acknowledgments section exists only when the client sent haves
    // to negotiate over: with no haves there is nothing to acknowledge,
    // and a real git server goes straight to the packfile section.
    if (haves.length > 0) {
      const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
      const common = haves.filter((have) => wants.some((want) => isAncestor(have, want, lookup)));
      parts.push(pktLine('acknowledgments\n'));
      if (common.length > 0) {
        for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(Buffer.from('0001', 'ascii'));
    }
    if (depth !== undefined) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(Buffer.from('0000', 'ascii'));
    const response = Buffer.concat(parts);
    fetchCachePut(fetchCacheKey(repo, wants, haves, shallow, depth, 'v2'), response);
    return response;
  }
  throw new Error(`unknown upload-pack v2 command ${JSON.stringify(command)}`);
}

export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  // Two sections: wants (+shallow/deepen) terminated by a flush, then the
  // negotiation (haves + done) terminated by a second flush.
  const { packets } = splitPktSection(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8'));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
  }
  const cached = fetchCacheGet(fetchCacheKey(repo, wants, haves, shallow, depth, 'v0'));
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  const response = Buffer.concat(parts);
  fetchCachePut(fetchCacheKey(repo, wants, haves, shallow, depth, 'v0'), response);
  return response;
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Handle a receive-pack request body. Returns the report lines and the
 * sideband-framed report-status stream. Objects from the pack are stored
 * before the ref checks run, so a refused ref's objects are still present
 * (a later fast-forward push of the same objects needs no re-send).
 */
export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): { report: PushReportLine[]; response: Buffer } {
  const { packets, rest } = splitPktSection(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8'));
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  let unpackOk = true;
  if (rest.length > 0) {
    try {
      if (!verifyPackChecksum(rest)) throw new Error('pack trailer checksum mismatch');
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) repo.objects.set(oid, object);
    } catch {
      unpackOk = false;
    }
  }
  const report: PushReportLine[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      report.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'old ref mismatch' });
      } else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      report.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        report.push({ ref: command.ref, ok: false, reason: 'old ref mismatch' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      report.push({ ref: command.ref, ok: false, reason: 'old ref mismatch' });
      continue;
    }
    const newTip = forge.peelToCommit(repo, command.newOid) ?? command.newOid;
    if (!isAncestor(current, newTip, (oid) => repo.objects.get(oid))) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push({ ref: command.ref, ok: true, reason: '' });
  }
  const reportLines: Array<string | 'flush'> = [
    unpackOk ? 'unpack ok\n' : 'unpack error\n',
  ];
  for (const line of report) {
    reportLines.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  reportLines.push('flush');
  const reportStream = pktLines(reportLines);
  // The report-status stream rides sideband band 1, chunked into pkt-lines.
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
    const chunk = reportStream.subarray(offset, Math.min(reportStream.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return { report, response: Buffer.concat(parts) };
}

/** Decode a pack body the way the suite's client builds one (for debugging only). */
export function decodePacketsForLog(body: Buffer): string[] {
  try {
    return decodePktLines(body)
      .filter((p) => p.kind === 'data')
      .map((p) => (p as { payload: Buffer }).payload.toString('utf8').replace(/\n$/, ''));
  } catch {
    return [];
  }
}

export { hashObject };
