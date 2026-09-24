"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Download, FileText, Folder, FolderPlus, Info, LoaderCircle, MoreHorizontal, Pencil, Save, TextCursorInput, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CSRF_HEADER } from "@/lib/csrf";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "../common";
import { api, errorMessage, formatBytes, formatDate, formatRelative, serverHref } from "../lib";
import { useNow } from "../panel-context";
import type { MinecraftServer, ServerFileEntry } from "../types";

type UploadProgress = { name: string; loaded: number; total: number };
const MANAGED_FILES: Record<string, string> = {
  "server.properties": "Blocky sets several of these keys (MOTD, difficulty, max players, distances, whitelist) every time the server starts, so edits to those keys here are overwritten. Use Settings instead; other keys can go in Custom server.properties there.",
  "whitelist.json": "When a whitelist is set in Settings, it replaces this file on every start. Manage players in Settings, or with the console's whitelist command.",
  "ops.json": "Changes take effect after a restart. You can also use the console's op and deop commands, which apply immediately.",
};

function uploadFile(url: string, file: File, onProgress: (loaded: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader(CSRF_HEADER, "1");
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return resolve();
      try { reject(new Error((JSON.parse(request.responseText) as { error?: string }).error || `Upload failed (${request.status}).`)); }
      catch { reject(new Error(`Upload failed (${request.status}).`)); }
    };
    request.onerror = () => reject(new Error("The connection was lost during the upload."));
    request.send(file);
  });
}

function Editor({ server, file, onClose, onSaved }: { server: MinecraftServer; file: { path: string; content: string }; onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = useState(file.content);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = content !== file.content;
  const name = file.path.split("/").pop() || file.path;
  const managedNote = !file.path.includes("/") ? MANAGED_FILES[name] : undefined;
  const save = useCallback(async () => {
    setSaving(true);
    try { await api(`/api/servers/${server.id}/files?path=`, { method: "PATCH", body: JSON.stringify({ path: file.path, content }) }); toast.success(`${name} saved.`); onSaved(); }
    catch (error) { toast.error(errorMessage(error, "Could not save the file.")); }
    finally { setSaving(false); }
  }, [server.id, file.path, content, name, onSaved]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const requestClose = () => dirty ? setConfirmDiscard(true) : onClose();
  return <Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
    <DialogContent className="dialog-sheet-mobile flex max-h-[92vh] flex-col border-border bg-popover text-foreground sm:max-w-3xl" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (dirty && !saving) void save(); } }}>
      <DialogHeader className="text-left"><DialogTitle className="truncate font-mono text-base">{file.path}{dirty && <span className="ml-2 text-xs font-normal text-warning">unsaved</span>}</DialogTitle><DialogDescription>UTF-8 text. Press Ctrl+S to save.</DialogDescription></DialogHeader>
      {managedNote && <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-xs text-foreground"><Info className="mt-0.5 size-4 shrink-0 text-warning" /><div><p>{managedNote}</p>{name !== "ops.json" && <Link href={serverHref(server.id, "settings")} className="mt-1 inline-block font-medium underline underline-offset-2">Open Settings</Link>}</div></div>}
      <Textarea className="console min-h-[50vh] flex-1 resize-y rounded-lg text-xs" value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} autoCapitalize="off" aria-label={`Contents of ${file.path}`} />
      <DialogFooter><Button variant="ghost" onClick={requestClose}>Close</Button><Button onClick={() => void save()} disabled={!dirty || saving}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}Save</Button></DialogFooter>
      <ConfirmDialog open={confirmDiscard} onOpenChange={setConfirmDiscard} title="Discard unsaved changes?" confirmLabel="Discard" destructive onConfirm={onClose}><p>Your edits to {name} haven&apos;t been saved.</p></ConfirmDialog>
    </DialogContent>
  </Dialog>;
}

export function FilesTab({ server }: { server: MinecraftServer }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const currentPath = (params.get("path") || "").replace(/^\/+|\/+$/g, "");
  const now = useNow(60_000);
  const [entries, setEntries] = useState<ServerFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [newName, setNewName] = useState("");
  const [editor, setEditor] = useState<{ path: string; content: string } | null>(null);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [pendingOverwrite, setPendingOverwrite] = useState<File[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ServerFileEntry | null>(null);
  const [renaming, setRenaming] = useState<{ entry: ServerFileEntry; name: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const endpoint = useCallback((path: string, mode?: string) => { const query = new URLSearchParams({ path }); if (mode) query.set("mode", mode); return `/api/servers/${server.id}/files?${query}`; }, [server.id]);
  const goTo = (path: string) => router.push(path ? `${pathname}?path=${encodeURIComponent(path)}` : pathname, { scroll: false });
  const joined = (name: string) => currentPath ? `${currentPath}/${name}` : name;

  const load = useCallback(async () => {
    setLoading(true);
    try { setEntries((await api<{ entries: ServerFileEntry[] }>(endpoint(currentPath))).entries); }
    catch (error) { setEntries([]); toast.error(errorMessage(error, "Could not load files.")); }
    finally { setLoading(false); }
  }, [currentPath, endpoint]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function create(type: "file" | "directory") {
    const name = newName.trim();
    if (!name || /[\\/]/.test(name)) return toast.error("Enter a name without slashes.");
    if (entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) return toast.error("That name already exists here.");
    setWorking(true);
    try {
      if (type === "directory") await api(endpoint(""), { method: "POST", body: JSON.stringify({ path: joined(name) }) });
      else await api(endpoint(""), { method: "PATCH", body: JSON.stringify({ path: joined(name), content: "" }) });
      setNewName(""); toast.success(`${type === "directory" ? "Folder" : "File"} created.`); await load();
      if (type === "file") setEditor({ path: joined(name), content: "" });
    } catch (error) { toast.error(errorMessage(error, "Could not create it.")); }
    finally { setWorking(false); }
  }

  async function open(entry: ServerFileEntry) {
    if (entry.type === "directory") return goTo(entry.path);
    if (!entry.editable) { window.location.href = endpoint(entry.path, "download"); toast.info(`Downloading ${entry.name}`, { description: "Files over 2 MB can't be edited in the browser." }); return; }
    setWorking(true);
    try { setEditor({ path: entry.path, content: (await api<{ content: string }>(endpoint(entry.path, "content"))).content }); }
    catch (error) {
      toast.error(errorMessage(error, "This file can't be edited."));
      if (/binary/i.test(errorMessage(error, ""))) window.location.href = endpoint(entry.path, "download");
    } finally { setWorking(false); }
  }

  function queueUploads(files: File[]) {
    if (!files.length) return;
    const existing = files.filter((file) => entries.some((entry) => entry.name === file.name));
    if (existing.length) setPendingOverwrite(files);
    else void startUploads(files);
  }

  async function startUploads(files: File[]) {
    setUploads(files.map((file) => ({ name: file.name, loaded: 0, total: file.size })));
    let failed = 0;
    for (const [index, file] of files.entries()) {
      try { await uploadFile(endpoint(joined(file.name)), file, (loaded) => setUploads((current) => current.map((item, i) => i === index ? { ...item, loaded } : item))); }
      catch (error) { failed += 1; toast.error(`${file.name}: ${errorMessage(error, "upload failed")}`); }
    }
    setUploads([]);
    if (files.length - failed) toast.success(`${files.length - failed} file${files.length - failed === 1 ? "" : "s"} uploaded.`);
    await load();
  }

  async function remove(entry: ServerFileEntry) {
    setWorking(true);
    try { await api(endpoint(entry.path), { method: "DELETE" }); toast.success(`${entry.name} deleted.`); await load(); }
    catch (error) { toast.error(errorMessage(error, "Delete failed.")); }
    finally { setWorking(false); }
  }

  async function rename() {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name || /[\\/]/.test(name)) return toast.error("Enter a name without slashes.");
    setWorking(true);
    try { await api(endpoint(""), { method: "POST", body: JSON.stringify({ from: renaming.entry.path, to: joined(name) }) }); toast.success(`Renamed to ${name}.`); setRenaming(null); await load(); }
    catch (error) { toast.error(errorMessage(error, "Rename failed.")); }
    finally { setWorking(false); }
  }

  const crumbs = currentPath ? currentPath.split("/") : [];
  return <div className="space-y-4">
    <p className="flex gap-2 rounded-xl border border-border bg-muted/50 p-3 text-xs leading-5 text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" /><span>Changes go straight to the live server folder. Stop the server before replacing a world or editing files the game might overwrite.</span></p>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label="Folder" className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-sm">
        <button type="button" className="rounded px-2 py-1 font-mono text-foreground hover:bg-accent" onClick={() => goTo("")}>/data</button>
        {crumbs.map((crumb, index) => <span className="flex items-center" key={`${crumb}-${index}`}><ChevronRight className="size-3.5 text-muted-foreground" /><button type="button" aria-current={index === crumbs.length - 1 ? "page" : undefined} className="rounded px-2 py-1 font-mono text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:text-foreground" onClick={() => goTo(crumbs.slice(0, index + 1).join("/"))}>{crumb}</button></span>)}
      </nav>
      <div className="flex gap-2">
        <input ref={uploadInput} className="hidden" type="file" multiple onChange={(event) => { queueUploads([...(event.target.files || [])]); event.target.value = ""; }} />
        <Button size="sm" variant="outline" onClick={() => uploadInput.current?.click()} disabled={working || uploads.length > 0}><Upload />Upload</Button>
      </div>
    </div>
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void create("file"); }}>
      <Input placeholder="New file or folder name" aria-label="New file or folder name" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={working} autoCapitalize="off" spellCheck={false} />
      <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => void create("directory")} disabled={!newName.trim() || working}><FolderPlus />Folder</Button><Button type="submit" variant="outline" disabled={!newName.trim() || working}><FileText />File</Button></div>
    </form>
    {uploads.length > 0 && <ul className="space-y-2 rounded-xl border border-border bg-card p-3" aria-label="Uploads in progress">
      {uploads.map((upload) => <li key={upload.name} className="text-xs"><div className="flex justify-between gap-2"><span className="truncate">{upload.name}</span><span className="text-muted-foreground">{formatBytes(upload.loaded)} / {formatBytes(upload.total)}</span></div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`Uploading ${upload.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.total ? Math.round((upload.loaded / upload.total) * 100) : 0}><div className="h-full bg-foreground/70" style={{ width: `${upload.total ? (upload.loaded / upload.total) * 100 : 0}%` }} /></div></li>)}
    </ul>}
    <div className={cn("relative overflow-hidden rounded-xl border bg-card", dragging ? "border-foreground/50" : "border-border")}
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); queueUploads([...event.dataTransfer.files]); }}>
      {dragging && <div className="absolute inset-0 z-10 grid place-items-center bg-background/85 text-sm font-medium"><span className="flex items-center gap-2"><Upload className="size-4" />Drop to upload into /{currentPath}</span></div>}
      {currentPath && <button type="button" className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left text-sm text-muted-foreground hover:bg-muted/50" onClick={() => goTo(crumbs.slice(0, -1).join("/"))}><Folder className="size-4" />.. <span className="text-xs">(up one folder)</span></button>}
      {loading ? <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        : entries.length ? <ul className="divide-y divide-border">{entries.map((entry) => <li key={entry.path} className="flex items-center gap-2 px-2 py-1 hover:bg-muted/40 sm:px-3">
          <button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-left" onClick={() => void open(entry)} disabled={working}>
            {entry.type === "directory" ? <Folder className="size-4 shrink-0" /> : <FileText className="size-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:block" title={formatDate(entry.modifiedAt)}>{formatRelative(entry.modifiedAt, now)}</span>
            <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{entry.type === "file" ? formatBytes(entry.size) : "Folder"}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Actions for ${entry.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {entry.type === "file" && entry.editable && <DropdownMenuItem onSelect={() => void open(entry)}><Pencil />Edit</DropdownMenuItem>}
              {entry.type === "file" && <DropdownMenuItem asChild><a href={endpoint(entry.path, "download")}><Download />Download</a></DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setRenaming({ entry, name: entry.name })}><TextCursorInput />Rename</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setPendingDelete(entry)}><Trash2 />Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>)}</ul>
          : <div className="p-10 text-center text-sm text-muted-foreground">This folder is empty. Drop files here to upload them.</div>}
    </div>
    {editor && <Editor server={server} file={editor} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void load(); }} />}
    <ConfirmDialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)} destructive title={`Delete ${pendingDelete?.name}?`} confirmLabel="Delete" onConfirm={() => pendingDelete && void remove(pendingDelete)}>
      <p>{pendingDelete?.type === "directory" ? `This permanently deletes ${pendingDelete.path} and everything inside it.` : `This permanently deletes ${pendingDelete?.path}.`} Back up first if you might need it.</p>
    </ConfirmDialog>
    <ConfirmDialog open={Boolean(pendingOverwrite)} onOpenChange={(open) => !open && setPendingOverwrite(null)} title="Replace existing files?" confirmLabel="Replace" onConfirm={() => { const files = pendingOverwrite; setPendingOverwrite(null); if (files) void startUploads(files); }}>
      <p>These already exist in /{currentPath || ""} and will be replaced: <span className="font-mono text-foreground">{pendingOverwrite?.filter((file) => entries.some((entry) => entry.name === file.name)).map((file) => file.name).join(", ")}</span></p>
    </ConfirmDialog>
    <Dialog open={Boolean(renaming)} onOpenChange={(open) => !open && setRenaming(null)}>
      <DialogContent className="border-border bg-popover text-foreground">
        <form onSubmit={(event) => { event.preventDefault(); void rename(); }} className="grid gap-4">
          <DialogHeader><DialogTitle>Rename {renaming?.entry.name}</DialogTitle><DialogDescription>Stays in the same folder.</DialogDescription></DialogHeader>
          <div className="field"><Label htmlFor="rename-input">New name</Label><Input id="rename-input" value={renaming?.name || ""} onChange={(event) => renaming && setRenaming({ ...renaming, name: event.target.value })} autoFocus autoCapitalize="off" spellCheck={false} /></div>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button><Button type="submit" disabled={working || !renaming?.name.trim() || renaming.name.trim() === renaming.entry.name}>Rename</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
