import { assertAdmin, getAdminPassword, getBucket } from '@/lib/cf';
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

type ObjectInfo = { key: string; size: number; etag: string; uploaded: Date; httpMetadata?: Record<string, string>; customMetadata?: Record<string, string>; body: ReadableStream };
type Bucket = {
  list(o: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }): Promise<{ objects: ObjectInfo[]; delimitedPrefixes: string[]; truncated: boolean; cursor?: string }>;
  head(k: string): Promise<ObjectInfo | null>;
  get(k: string): Promise<ObjectInfo | null>;
  put(k: string, body: ReadableStream | string, o?: Record<string, unknown>): Promise<ObjectInfo | null>;
  delete(k: string | string[]): Promise<void>;
};
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
function auth(req: Request) {
  if (!getAdminPassword()) fail('管理员密码未配置，后台已禁用', 503);
  assertAdmin(req);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) fail('禁止跨站请求', 403);
}
function key(value: unknown, root = false): string {
  if (typeof value !== 'string') return fail('无效路径');
  if (root && value === '') return '';
  const parts = value.replace(/\/$/, '').split('/');
  if (!value || value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value) || parts.some(p => !p.trim() || p === '.' || p === '..') || new TextEncoder().encode(value).length > 1024) fail('路径无效：不能包含空段、反斜杠或 ..');
  return value;
}
async function exists(b: Bucket, k: string) {
  const parts = k.replace(/\/$/, '').split('/');
  for (let i = 1; i < parts.length; i++) {
    if (await b.head(parts.slice(0, i).join('/'))) fail('父路径是文件，不能作为目录', 409);
  }
  if (await b.head(k.replace(/\/$/, ''))) return true;
  const p = await b.list({ prefix: k.replace(/\/$/, '') + '/', limit: 1 });
  return p.objects.length > 0;
}
async function expand(b: Bucket, keys: string[]) {
  const objects = new Map<string, ObjectInfo>();
  for (const k of keys) {
    if (!k.endsWith('/')) {
      const obj = await b.head(k);
      if (!obj) fail('文件不存在：' + k, 404);
      objects.set(k, obj);
    } else {
      let cursor: string | undefined;
      let found = false;
      do {
        const p = await b.list({ prefix: k, cursor, limit: 101 });
        for (const obj of p.objects) { objects.set(obj.key, obj); found = true; }
        if (objects.size > 100) fail('单次操作最多包含 100 个对象，请分批操作');
        cursor = p.truncated ? p.cursor : undefined;
      } while (cursor);
      if (!found) fail('目录不存在：' + k, 404);
    }
    if (objects.size > 100) fail('单次操作最多包含 100 个对象，请分批操作');
  }
  return [...objects.values()];
}
export async function GET(req: Request) {
  try {
    auth(req);
    const url = new URL(req.url);
    const prefix = key(url.searchParams.get('prefix') || '', true);
    if (prefix && !prefix.endsWith('/')) fail('目录路径须以 / 结尾');
    const b = getBucket() as unknown as Bucket;
    const p = await b.list({ prefix, delimiter: '/', limit: 200, cursor: url.searchParams.get('cursor') || undefined });
    return json({ folders: p.delimitedPrefixes, files: p.objects.filter(o => o.key !== prefix).map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded })), cursor: p.truncated ? p.cursor : null });
  } catch (e) { return error(e); }
}
function error(e: unknown) { const err = e as Error & { status?: number }; return json({ error: err.message || '操作失败' }, err.status || 500); }
export async function POST(req: Request) {
  try {
    auth(req);
    const body = await req.json();
    const b = getBucket() as unknown as Bucket;
    if (body.action === 'mkdir') {
      const folder = key(body.key).replace(/\/$/, '') + '/';
      if (await exists(b, folder)) fail('同名文件或目录已存在', 409);
      const r = await b.put(folder, '', { onlyIf: { etagDoesNotMatch: '*' } });
      if (!r) fail('同名目录已存在', 409);
      return json({ ok: true });
    }
    if (body.action === 'checkUpload') {
      const k = key(body.key);
      if (k.endsWith('/')) fail('文件名不能以 / 结尾');
      if (await exists(b, k)) fail('同名文件或目录已存在，请先重命名', 409);
      return json({ ok: true });
    }
    if (!['delete', 'move', 'rename'].includes(body.action)) fail('未知操作');
    if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > 100) fail('请选择 1–100 个条目');
    const keys = [...new Set<string>(body.keys.map((k: unknown) => key(k)))].sort();
    // Ignore descendants when their parent folder is already selected.
    const roots = keys.filter(k => !keys.some(p => p !== k && p.endsWith('/') && k.startsWith(p)));
    const objects = await expand(b, roots);
    if (body.action === 'delete') {
      if (body.confirm !== true) fail('删除必须确认');
      await b.delete(objects.map(o => o.key));
      return json({ ok: true, count: objects.length });
    }
    if (body.action === 'rename' && roots.length !== 1) fail('重命名每次只能选择一个条目');
    const dest = key(body.destination, body.action === 'move');
    if (body.action === 'move' && dest && !dest.endsWith('/')) fail('目标目录须以 / 结尾');
    const mapping = roots.map(source => {
      const base = source.replace(/\/$/, '').split('/').pop()!;
      const target = body.action === 'move' ? dest + base + (source.endsWith('/') ? '/' : '') : dest;
      key(target);
      if (source.endsWith('/') !== target.endsWith('/')) fail('不能改变文件与目录类型');
      if (source === target || (source.endsWith('/') && target.startsWith(source))) fail('不能移动到原路径或自身子目录');
      return { source, target };
    });
    if (new Set(mapping.map(m => m.target)).size !== mapping.length) fail('目标名称冲突', 409);
    for (const m of mapping) if (await exists(b, m.target)) fail('目标已存在：' + m.target, 409);
    if (objects.some(o => o.size > 500 * 1024 * 1024) || objects.reduce((n, o) => n + o.size, 0) > 1024 * 1024 * 1024) fail('单次移动/重命名限总计 1GB，单文件限 500MB');
    const copied: string[] = [];
    // Copy the entire plan successfully before removing ANY source objects.
    try {
      for (const obj of objects) {
        const m = mapping.find(m => obj.key === m.source || (m.source.endsWith('/') && obj.key.startsWith(m.source)))!;
        const target = m.target + obj.key.slice(m.source.length);
        const source = await b.get(obj.key);
        if (!source || source.etag !== obj.etag) fail('源文件已变化，请刷新后重试', 409);
        const result = await b.put(target, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata, onlyIf: { etagDoesNotMatch: '*' } });
        if (!result) fail('目标已存在：' + target, 409);
        copied.push(target);
        if (result.size !== obj.size) fail('副本大小校验失败', 500);
      }
      for (const obj of objects) if ((await b.head(obj.key))?.etag !== obj.etag) fail('源文件已变化，保留原文件', 409);
    } catch (e) {
      // Keep verified copies for recovery; never erase user data to simulate rollback.
      return json({ error: (e as Error).message, copied, note: '操作未完成，原文件均保留；可能已有副本，请刷新检查后重试。' }, 409);
    }
    await b.delete(objects.map(o => o.key));
    return json({ ok: true, count: objects.length });
  } catch (e) { return error(e); }
}

// Small uploads use an atomic create-only write; large uploads use existing multipart API.
export async function PUT(req: Request) {
  try {
    auth(req);
    const k = key(new URL(req.url).searchParams.get('key'));
    if (k.endsWith('/')) fail('文件名不能以 / 结尾');
    const length = Number(req.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) fail('此接口只接受 8MB 以内的文件', 413);
    const b = getBucket() as unknown as Bucket;
    if (await exists(b, k)) fail('同名文件或目录已存在', 409);
    const result = await b.put(k, req.body || '', { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: req.headers.get('content-type') || 'application/octet-stream' } });
    if (!result) fail('同名文件已存在', 409);
    return json({ ok: true });
  } catch (e) { return error(e); }
}
