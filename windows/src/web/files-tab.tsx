import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Download, FilePlus, FileText, Folder, FolderPlus, LoaderCircle, Pencil, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { api, formatBytes, type Server } from "./api";
import { Dialog, Field, pushToast, run, Section } from "./ui";
import type { FileEntry } from "../server/files";

export function FilesTab({ server }: { server: Server }) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ path: string; content: string; modifiedAt?: string; revision?: string } | null>(null);
  const [action, setAction] = useState<{ kind: "folder" | "text" | "rename" | "delete"; entry?: FileEntry } | null>(null);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const active = ["installing", "starting", "running", "stopping"].includes(server.status);
  const prefix = `/api/servers/${server.id}`;
  const revision = useRef(0);
  const load = useCallback(async () => {
    const current = ++revision.current;
    if (active) { setEntries(null); return; }
    setError("");
    try { const data = await api<{ entries: FileEntry[] }>(`/api/servers/${server.id}/files?path=${encodeURIComponent(directory)}`); if (current === revision.current) setEntries(data.entries); }
    catch (error) { if (current === revision.current) { setError(error instanceof Error ? error.message : "Could not load files."); setEntries(null); } }
  }, [server.id, directory, active]);
  useEffect(() => { setEntries(null); void load(); return () => { revision.current++; }; }, [load]);
  const child = (value: string) => directory ? `${directory}/${value}` : value;
  const execute = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await work(); pushToast(message); await load(); }
    catch (error) { pushToast(error instanceof Error ? error.message : "File operation failed.", "error"); }
    finally { setBusy(false); }
  };
  const edit = (entry: FileEntry) => run(async () => {
    const data = await api<{ content: string; modifiedAt: string; revision: string }>(`${prefix}/files?text=1&path=${encodeURIComponent(entry.path)}`);
    setEditor({ path: entry.path, ...data });
  });
  const submit = () => execute(async () => {
    if (!action) return;
    if (action.kind === "folder") await api(`${prefix}/files`, { method: "POST", body: { path: child(name.trim()) } });
    if (action.kind === "text") { setEditor({ path: child(name.trim()), content: "" }); setAction(null); return; }
    if (action.kind === "rename") await api(`${prefix}/files`, { method: "PATCH", body: { path: action.entry!.path, destination: child(name.trim()) } });
    if (action.kind === "delete") await api(`${prefix}/files?path=${encodeURIComponent(action.entry!.path)}`, { method: "DELETE" });
    setAction(null);
  }, action?.kind === "text" ? "New file ready to edit." : "File operation completed.");
  const upload = (file: File) => execute(async () => {
    if (file.size > 256 * 1024 ** 2) throw new Error("Uploads must be at most 256 MB.");
    const response = await fetch(`${prefix}/upload?path=${encodeURIComponent(child(file.name))}`, { method: "POST", headers: { "x-blocky-request": "1", "Content-Type": "application/octet-stream" }, body: file });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || "Upload failed."); }
  }, "File uploaded.");
  if (active) return <Section title="Files"><p className="text-sm text-muted-foreground">Stop the server to browse, edit, upload, or download its files. This keeps files stable while you manage them.</p></Section>;
  return <>
    <Section title="Files" description="Browse the server folder, edit text configuration files, and upload plugins or mods. Uploads are limited to 256 MB."
      actions={<>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => { setName(""); setAction({ kind: "folder" }); }}><FolderPlus />New folder</button>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => { setName("notes.txt"); setAction({ kind: "text" }); }}><FilePlus />New text file</button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? <LoaderCircle className="animate-spin" /> : <Upload />}Upload</button>
        <input ref={input} type="file" className="hidden" aria-label="Upload a server file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      </>}>
      <div className="mb-4 flex items-center gap-2">
        <button className="btn btn-outline btn-sm" disabled={!directory || busy} aria-label="Parent folder" onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}><ArrowUp /></button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void load()} aria-label="Refresh files"><RefreshCw /></button>
        <p className="min-w-0 truncate font-mono text-sm" title={directory || "/"}>{directory || "/"}</p>
      </div>
      {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      {entries === null ? <p className="text-sm text-muted-foreground">{error ? "Refresh to try again." : "Loading files…"}</p>
        : !entries.length ? <p className="py-8 text-center text-sm text-muted-foreground">This folder is empty.</p>
          : <ul className="divide-y divide-border">{entries.map((entry) => <li key={entry.path} className="flex items-center gap-3 py-3 text-sm">
            {entry.type === "directory" ? <Folder className="size-4 shrink-0 text-primary" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
            <button className="min-w-0 flex-1 truncate text-left font-medium hover:underline disabled:no-underline" disabled={busy || (entry.type === "file" && !entry.editable)} onClick={() => entry.type === "directory" ? setDirectory(entry.path) : void edit(entry)} title={entry.name}>{entry.name}</button>
            <span className="hidden text-xs text-muted-foreground sm:inline">{entry.type === "file" ? formatBytes(entry.size) : "Folder"}</span>
            {entry.type === "file" && <a className="btn btn-ghost btn-sm" aria-label={`Download ${entry.name}`} href={`${prefix}/download?path=${encodeURIComponent(entry.path)}`} download><Download /></a>}
            <button className="btn btn-ghost btn-sm" disabled={busy} aria-label={`Rename ${entry.name}`} onClick={() => { setName(entry.name); setAction({ kind: "rename", entry }); }}><Pencil /></button>
            <button className="btn btn-ghost btn-sm text-destructive" disabled={busy} aria-label={`Delete ${entry.name}`} onClick={() => setAction({ kind: "delete", entry })}><Trash2 /></button>
          </li>)}</ul>}
    </Section>
    {action && <Dialog title={action.kind === "delete" ? `Delete ${action.entry!.name}?` : action.kind === "folder" ? "New folder" : action.kind === "text" ? "New text file" : "Rename"} onClose={() => { if (!busy) setAction(null); }}
      footer={<><button className="btn btn-outline" disabled={busy} onClick={() => setAction(null)}>Cancel</button><button className={`btn ${action.kind === "delete" ? "btn-danger" : "btn-primary"}`} disabled={busy || (action.kind !== "delete" && !name.trim())} onClick={() => void submit()}>{action.kind === "delete" ? "Delete" : "Continue"}</button></>}>
      {action.kind === "delete" ? <p className="text-sm text-muted-foreground">This removes {action.entry!.type === "directory" ? "this folder and everything inside it" : "this file"}. Make a backup first if you may need it again.</p>
        : <Field label="Name"><input className="input" autoFocus value={name} maxLength={200} onChange={(event) => setName(event.target.value)} /></Field>}
    </Dialog>}
    {editor && <Dialog wide title={editor.path} onClose={() => { if (!busy && (editor.content === "" || window.confirm("Close the editor? Any unsaved changes will be lost."))) setEditor(null); }}
      footer={<><button className="btn btn-outline" disabled={busy} onClick={() => { if (window.confirm("Close without saving?")) setEditor(null); }}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void execute(async () => { await api(`${prefix}/files`, { method: "PUT", body: editor }); setEditor(null); }, "File saved.")}><Save />Save</button></>}>
      <textarea className="input min-h-80 resize-y py-3 font-mono text-xs" aria-label={`Edit ${editor.path}`} spellCheck={false} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} />
      <p className="mt-2 text-xs text-muted-foreground">Panel-managed server.properties settings are applied from Settings when the server starts.</p>
    </Dialog>}
  </>;
}
