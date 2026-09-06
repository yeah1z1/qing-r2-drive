"use client";
import { useState } from 'react';
import Link from 'next/link';

type Entry = { key: string; size?: number; folder: boolean };
type Auth = { user: string; password: string };
const CHUNK = 8 * 1024 * 1024;
// Match the original drive's blue primary buttons and outlined secondary actions.
const baseButton = 'inline-flex items-center justify-center gap-1.5 min-h-10 px-2.5 py-2 rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-40 disabled:pointer-events-none active:scale-95';
const style = baseButton + ' bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:border-blue-500 dark:hover:text-blue-400 dark:hover:bg-blue-900/20 hover:shadow-sm';
const primary = baseButton + ' bg-blue-600 text-white hover:bg-blue-700 dark:hover:bg-blue-500 shadow-sm hover:shadow-md border border-transparent';
const danger = baseButton + ' border border-red-200 dark:border-red-900/50 bg-white dark:bg-gray-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-300';
const inputStyle = 'w-full mt-2 px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-colors';
const iconPaths = {
  upload: 'M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4',
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z',
  rename: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z',
  move: 'M3 7h7l2 2h9v11H3V7Zm11 6 3 3-3 3m-5-3h8',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2',
  home: 'm3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5V10Zm7 4v3',
  exit: 'M9 4H4v16h5m6-13 5 5-5 5m-6-5h11',
  file: 'M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6',
};
function Icon({ name, className = '' }: { name: keyof typeof iconPaths; className?: string }) {
  return <svg aria-hidden="true" className={'h-4 w-4 shrink-0 ' + className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[name]} /></svg>;
}
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
  return <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 text-gray-900 dark:text-gray-100">
    <div className="flex flex-wrap justify-between gap-4 items-center mb-4">
      <div><h1 className="text-xl sm:text-2xl font-bold tracking-tight">文件管理</h1><p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Mikoo&apos;s R2 Admin</p></div>
      <div className="flex gap-2"><Link className={style} href="/"><Icon name="home" />返回网盘</Link>{auth && <button className={style} disabled={busy} onClick={() => { setAuth(null); setEntries([]); setSelected([]); setNotice('已退出'); }}><Icon name="exit" />退出登录</button>}</div>
    </div>
    <p className="text-xs sm:text-sm leading-relaxed text-gray-500 dark:text-gray-400 mb-6">管理现有 R2 桶。这里上传的文件仍可在公开网盘访问。请勿多人同时修改同一文件。</p>
    {notice && <div role="status" className="whitespace-pre-wrap break-words rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-100 dark:border-blue-800/50 px-4 py-3 mb-5 text-sm leading-relaxed">{notice}</div>}
    {!auth ? <form className="max-w-md mx-auto my-8 sm:my-12 space-y-5 border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 rounded-2xl p-6 sm:p-8 shadow-sm" onSubmit={e => { e.preventDefault(); void run(login); }}>
      <div className="h-12 w-12 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center"><Icon name="lock" className="!h-6 !w-6" /></div>
      <div><h2 className="text-xl font-semibold">管理员登录</h2><p className="text-sm text-gray-500 dark:text-gray-400 mt-2">登录后管理你的文件与目录</p></div>
      <label className="block text-sm font-medium">账号<input autoComplete="username" className={inputStyle} value={user} onChange={e => setUser(e.target.value)} required /></label>
      <label className="block text-sm font-medium">密码<input autoComplete="current-password" type="password" className={inputStyle} value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <button disabled={busy} className={primary + ' w-full !min-h-11'}><Icon name="lock" />{busy ? '验证中…' : '登录'}</button>
      <p className="text-xs leading-relaxed text-gray-400 dark:text-gray-500">使用你网盘的管理员账号和密码。刷新页面后需重新登录，不写入本地存储。</p>
    </form> : <>
      <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-2 mb-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 shadow-sm">
        <label className={primary + ' relative focus-within:ring-2 focus-within:ring-blue-400 focus-within:ring-offset-2' + (busy ? ' opacity-40 pointer-events-none' : ' cursor-pointer')}><Icon name="upload" />上传文件<input aria-label="上传文件" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" type="file" multiple disabled={busy} onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; if (files.length) void run(() => upload(files)); }} /></label>
        <button className={style} disabled={busy} onClick={() => void run(() => action('mkdir'))}><Icon name="folder" />新建目录</button>
        <button className={style} disabled={busy || selected.length !== 1} onClick={() => void run(() => action('rename'))}><Icon name="rename" />重命名</button>
        <button className={style} disabled={busy || !selected.length} onClick={() => void run(() => action('move'))}><Icon name="move" />移动{selected.length > 0 && <span className="text-xs">{selected.length}</span>}</button>
        <button className={danger} disabled={busy || !selected.length} onClick={() => void run(() => action('delete'))}><Icon name="trash" />删除{selected.length > 0 && <span className="text-xs">{selected.length}</span>}</button>
        <button className={style + ' sm:ml-auto'} disabled={busy} onClick={() => void run(() => load())}><Icon name="refresh" className={busy ? 'animate-spin' : ''} />刷新</button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mb-3 break-all">
        <button disabled={busy} className="text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-md px-2 py-1 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" onClick={() => void run(() => load(''))}>根目录</button>
        {prefix.split('/').filter(Boolean).map((part, i, all) => <span key={i} className="flex items-center gap-1.5"> <span className="text-gray-300 dark:text-gray-600">/</span> <button disabled={busy} className="text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-md px-2 py-1 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" onClick={() => void run(() => load(all.slice(0, i + 1).join('/') + '/'))}>{part}</button></span>)}
      </div>
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
        <div className="flex gap-3 items-center px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-500 dark:text-gray-400"><input className="h-4 w-4 accent-blue-600 cursor-pointer" type="checkbox" aria-label="选择当前已加载的全部条目" disabled={busy || !entries.length} checked={entries.length > 0 && selected.length === entries.length} onChange={e => setSelected(e.target.checked ? entries.map(v => v.key) : [])} /><span>全选已加载条目 · {entries.length} 项</span></div>
        {entries.map(entry => <div key={entry.key} className={'flex gap-3 items-center border-b border-gray-100 dark:border-gray-800 last:border-0 px-4 py-4 transition-colors ' + (selected.includes(entry.key) ? 'bg-blue-50/70 dark:bg-blue-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50')}>
          <input className="h-4 w-4 accent-blue-600 shrink-0 cursor-pointer" type="checkbox" aria-label={'选择 ' + entry.key} disabled={busy} checked={selected.includes(entry.key)} onChange={e => setSelected(old => e.target.checked ? [...old, entry.key] : old.filter(k => k !== entry.key))} />
          <div className={'h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ' + (entry.folder ? 'bg-amber-50 text-amber-500 dark:bg-amber-900/20' : 'bg-blue-50 text-blue-500 dark:bg-blue-900/20')}><Icon name={entry.folder ? 'folder' : 'file'} className="!w-5 !h-5" /></div>
          <div className="min-w-0 flex-1 text-sm font-medium">{entry.folder ? <button disabled={busy} className="text-gray-800 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400 text-left break-all transition-colors" onClick={() => void run(() => load(entry.key))}>{entry.key.slice(prefix.length).replace(/\/$/, '')}</button> : <span className="break-all">{entry.key.slice(prefix.length)}</span>}</div>
          <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">{entry.folder ? '目录' : size(entry.size)}</span>
        </div>)}
        {!entries.length && <div className="py-12 px-4 text-center text-sm text-gray-400 dark:text-gray-500">{busy ? '正在加载…' : '当前目录为空'}</div>}
      </div>
      {cursor && <div className="flex justify-center mt-4"><button className={style} disabled={busy} onClick={() => void run(() => load(prefix, cursor))}>加载更多</button></div>}
      <p className="mt-6 text-xs leading-relaxed text-gray-400 dark:text-gray-500">上传支持多选与分片。批量操作每次最多 100 个对象（含目录内容）。移动/重命名单文件上限 500MB、单次总计 1GB；采用先复制校验再删除，非原子操作。关闭页面可能中断操作，遇到错误请刷新检查原文件与副本。</p>
    </>}
  </main>;
}
