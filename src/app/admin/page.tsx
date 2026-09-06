"use client";
import { useState } from 'react';
import Link from 'next/link';

type Entry = { key: string; size?: number; folder: boolean };
type Auth = { user: string; password: string };
const CHUNK = 8 * 1024 * 1024;
const style = 'rounded-lg border px-3 py-2 bg-white text-gray-800 disabled:opacity-40';
const size = (n = 0) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export default function AdminPage() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');
  const [prefix, setPrefix] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function request(path: string, options: RequestInit = {}, credentials = auth) {
    if (!credentials) throw Error('请先登录');
    const headers = new Headers(options.headers);
    headers.set('x-admin-username', credentials.user);
    headers.set('x-admin-password', credentials.password);
    const res = await fetch(path, { ...options, headers, cache: 'no-store' });
    if (res.status === 401) { setAuth(null); throw Error('账号或密码错误，请重新登录'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Error([data.error || `HTTP ${res.status}`, data.note].filter(Boolean).join('；'));
    }
    return res;
  }
  async function post(data: unknown, path = '/api/admin') {
    return (await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json();
  }
  async function load(path = prefix, next: string | null = null, credentials = auth) {
    const p = new URLSearchParams({ prefix: path });
    if (next) p.set('cursor', next);
    const data = await (await request('/api/admin?' + p, {}, credentials)).json();
    const rows: Entry[] = [...data.folders.map((key: string) => ({ key, folder: true })), ...data.files.map((f: { key: string; size: number }) => ({ ...f, folder: false }))];
    setEntries(old => next ? [...new Map([...old, ...rows].map(e => [e.key, e])).values()] : rows);
    setPrefix(path); setCursor(data.cursor); setSelected([]);
  }
  async function run(job: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await job(); } catch (e) { setNotice((e as Error).message); }
    finally { setBusy(false); }
  }
  async function login() {
    const credentials = { user, password };
    await request('/api/admin?prefix=', {}, credentials);
    await load('', null, credentials);
    setAuth(credentials); setPassword('');
    setNotice('登录成功，密码仅保留在当前页面内存中。');
  }
  function destination(value: string) {
    const path = value.trim().replace(/^\/+|\/+$/g, '');
    return path ? path + '/' : '';
  }
  async function action(kind: 'mkdir' | 'rename' | 'move' | 'delete') {
    let data: Record<string, unknown> = { action: kind, keys: selected };
    if (kind === 'mkdir') {
      const name = window.prompt('新目录名称（在当前目录创建）');
      if (name === null) return;
      if (!name.trim() || name.includes('/')) throw Error('请输入单个目录名称，不要包含 /');
      data = { action: kind, key: prefix + name.trim() + '/' };
    }
    if (kind === 'rename') {
      const old = selected[0];
      const folder = old.endsWith('/');
      const parts = old.replace(/\/$/, '').split('/');
      const name = window.prompt('新名称（重名不会覆盖）', parts.pop());
      if (name === null) return;
      if (!name.trim() || name.includes('/')) throw Error('名称不能为空或包含 /');
      data.destination = (parts.length ? parts.join('/') + '/' : '') + name.trim() + (folder ? '/' : '');
    }
    if (kind === 'move') {
      const path = window.prompt('目标目录完整路径，例如：资料/归档；填 / 表示根目录。不存在的目录会自动形成。', '/');
      if (path === null) return;
      data.destination = destination(path);
    }
    if (kind === 'delete' && !window.confirm(`永久删除以下 ${selected.length} 个条目及目录内全部文件？无法恢复。\n\n${selected.join('\n')}`)) return;
    if (kind === 'delete') data.confirm = true;
    try {
      const result = await post(data);
      setNotice(`操作成功${result.count ? `，处理 ${result.count} 个对象` : ''}`);
    } finally { await load(); }
  }
  async function upload(files: File[]) {
    let done = 0;
    const failed: string[] = [];
    for (const file of files) {
      const key = prefix + file.name;
      let uploadId: string | undefined;
      try {
        await post({ action: 'checkUpload', key });
        setNotice(`上传 ${done + 1}/${files.length}：${file.name}`);
        if (file.size <= CHUNK) {
          await request('/api/admin?key=' + encodeURIComponent(key), { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
        } else {
          const created = await post({ action: 'create', key, contentType: file.type || 'application/octet-stream' }, '/api/multipart');
          uploadId = created.uploadId;
          const parts = [];
          for (let offset = 0, partNumber = 1; offset < file.size; offset += CHUNK, partNumber++) {
            const p = new URLSearchParams({ key, uploadId: uploadId!, partNumber: String(partNumber) });
            const res = await request('/api/multipart?' + p, { method: 'PUT', body: file.slice(offset, offset + CHUNK) });
            const etag = res.headers.get('ETag');
            if (!etag) throw Error('上传分片未返回 ETag');
            parts.push({ etag, partNumber });
            setNotice(`上传：${file.name} ${Math.round(Math.min(offset + CHUNK, file.size) / file.size * 100)}%`);
          }
          await post({ action: 'checkUpload', key });
          await post({ action: 'complete', key, uploadId, parts }, '/api/multipart');
          uploadId = undefined;
        }
        done++;
      } catch (e) {
        failed.push(`${file.name}：${(e as Error).message}`);
        if (uploadId) {
          try { await post({ action: 'abort', key, uploadId }, '/api/multipart'); }
          catch { failed.push('分片清理失败，请在 R2 控制台检查未完成上传'); }
        }
      }
    }
    await load();
    setNotice(`上传完成：成功 ${done}/${files.length}${failed.length ? '\n' + failed.join('\n') : ''}`);
  }
  return <main className="max-w-6xl mx-auto p-4 text-gray-900 dark:text-gray-100">
    <div className="flex flex-wrap justify-between gap-3 items-center my-4">
      <h1 className="text-2xl font-bold">Mikoo&apos;s R2 Admin</h1>
      <div className="flex gap-2"><Link className={style} href="/">返回网盘</Link>{auth && <button className={style} disabled={busy} onClick={() => { setAuth(null); setEntries([]); setSelected([]); setNotice('已退出'); }}>退出登录</button>}</div>
    </div>
    <p className="text-sm text-gray-500 mb-4">管理现有 R2 桶。这里上传的文件仍可在公开网盘访问。请勿多人同时修改同一文件。</p>
    {notice && <div role="status" className="whitespace-pre-wrap break-words rounded-lg bg-blue-50 text-blue-900 border p-3 mb-4">{notice}</div>}
    {!auth ? <form className="max-w-sm space-y-4 border rounded-xl p-5" onSubmit={e => { e.preventDefault(); void run(login); }}>
      <h2 className="font-semibold">管理员登录</h2>
      <label className="block">账号<input autoComplete="username" className={style + ' w-full mt-1'} value={user} onChange={e => setUser(e.target.value)} required /></label>
      <label className="block">密码<input autoComplete="current-password" type="password" className={style + ' w-full mt-1'} value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <button disabled={busy} className={style + ' w-full'}>{busy ? '验证中…' : '登录'}</button>
      <p className="text-xs text-gray-500">使用你网盘的管理员账号和密码。刷新页面后需重新登录，不写入本地存储。</p>
    </form> : <>
      <div className="flex flex-wrap gap-2 mb-4">
        <label className={style + (busy ? ' opacity-40' : ' cursor-pointer')}>上传文件<input className="hidden" type="file" multiple disabled={busy} onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; if (files.length) void run(() => upload(files)); }} /></label>
        <button className={style} disabled={busy} onClick={() => void run(() => action('mkdir'))}>新建目录</button>
        <button className={style} disabled={busy || selected.length !== 1} onClick={() => void run(() => action('rename'))}>重命名</button>
        <button className={style} disabled={busy || !selected.length} onClick={() => void run(() => action('move'))}>移动 ({selected.length})</button>
        <button className={style + ' text-red-600'} disabled={busy || !selected.length} onClick={() => void run(() => action('delete'))}>删除 ({selected.length})</button>
        <button className={style} disabled={busy} onClick={() => void run(() => load())}>刷新</button>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3 break-all">
        <button disabled={busy} className="text-blue-600 underline" onClick={() => void run(() => load(''))}>根目录</button>
        {prefix.split('/').filter(Boolean).map((part, i, all) => <span key={i}> / <button disabled={busy} className="text-blue-600 underline" onClick={() => void run(() => load(all.slice(0, i + 1).join('/') + '/'))}>{part}</button></span>)}
      </div>
      <div className="border rounded-xl overflow-hidden">
        <div className="flex gap-3 p-3 border-b bg-gray-50 text-gray-700"><input type="checkbox" aria-label="选择当前已加载的全部条目" disabled={busy || !entries.length} checked={entries.length > 0 && selected.length === entries.length} onChange={e => setSelected(e.target.checked ? entries.map(v => v.key) : [])} /><span>全选已加载条目 · {entries.length} 项</span></div>
        {entries.map(entry => <div key={entry.key} className="flex gap-3 items-center border-b last:border-0 p-3">
          <input type="checkbox" aria-label={'选择 ' + entry.key} disabled={busy} checked={selected.includes(entry.key)} onChange={e => setSelected(old => e.target.checked ? [...old, entry.key] : old.filter(k => k !== entry.key))} />
          <div className="min-w-0 flex-1">{entry.folder ? <button disabled={busy} className="text-blue-600 text-left break-all" onClick={() => void run(() => load(entry.key))}>📁 {entry.key.slice(prefix.length).replace(/\/$/, '')}</button> : <span className="break-all">📄 {entry.key.slice(prefix.length)}</span>}</div>
          <span className="shrink-0 text-xs text-gray-500">{entry.folder ? '目录' : size(entry.size)}</span>
        </div>)}
        {!entries.length && <p className="text-center py-12 text-gray-500">{busy ? '正在加载…' : '当前目录为空'}</p>}
      </div>
      {cursor && <button className={style + ' mt-3'} disabled={busy} onClick={() => void run(() => load(prefix, cursor))}>加载更多</button>}
      <p className="mt-4 text-xs text-gray-500">上传支持多选与分片。批量操作每次最多 100 个对象（含目录内容）。移动/重命名单文件上限 500MB、单次总计 1GB；采用先复制校验再删除，非原子操作。关闭页面可能中断操作，遇到错误请刷新检查原文件与副本。</p>
    </>}
  </main>;
}
