"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ClipboardCopy, Command as CommandIcon, Pause, Play, Search, SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api, errorMessage, storageGet, storageSet } from "../lib";
import { usePanel } from "../panel-context";
import type { MinecraftServer } from "../types";

type Line = { id: number; kind: "log" | "command" | "reply" | "error"; text: string };
const MAX_LINES = 4000;
const QUICK_COMMANDS: { label: string; command: string; fill?: boolean }[] = [
  { label: "say…", command: "say ", fill: true }, { label: "list", command: "list" }, { label: "whitelist add…", command: "whitelist add ", fill: true },
  { label: "op…", command: "op ", fill: true }, { label: "kick…", command: "kick ", fill: true }, { label: "save-all", command: "save-all" },
  { label: "time set day", command: "time set day" }, { label: "weather clear", command: "weather clear" },
];

const RCON_NOISE = /Thread RCON Client .* (started|shutting down)/;

function lineClass(line: Line) {
  if (line.kind === "command") return "log-command";
  if (line.kind === "reply") return "log-reply";
  if (line.kind === "error" || /\b(ERROR|SEVERE|FATAL)\b|Exception/.test(line.text)) return "log-error";
  if (/\bWARN(ING)?\b/.test(line.text)) return "log-warn";
  return undefined;
}

function highlight(text: string, filter: string) {
  if (!filter) return text;
  const parts = text.split(new RegExp(`(${filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return parts.map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part);
}

export function ConsoleTab({ server }: { server: MinecraftServer }) {
  const { can } = usePanel();
  const [lines, setLines] = useState<Line[]>([]);
  const [connected, setConnected] = useState(false);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  // The panel's own RCON checks make Minecraft log a connect/disconnect pair; hidden unless asked for.
  const [showRconNoise, setShowRconNoise] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [leftBottomAt, setLeftBottomAt] = useState<number | null>(null);
  const [bufferedCount, setBufferedCount] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const pausedBuffer = useRef<Line[]>([]);
  const pausedRef = useRef(false);
  const historyIndex = useRef(-1);
  const historyKey = `blocky:history:${server.id}`;
  const running = server.status === "running";
  const quickCommands = QUICK_COMMANDS;
  const streamKey = server.status === "stopped" || server.status === "failed" ? "down" : "up";

  const append = useCallback((incoming: Line[]) => {
    if (pausedRef.current) { pausedBuffer.current.push(...incoming); setBufferedCount(pausedBuffer.current.length); return; }
    setLines((current) => [...current, ...incoming].slice(-MAX_LINES));
  }, []);
  const makeLines = useCallback((text: string, kind: Line["kind"]) => text.replace(/\r/g, "").split("\n").filter((line, index, all) => line || index < all.length - 1).map((line) => ({ id: nextId.current++, kind, text: line })), []);

  // Live log stream. Each (re)connection replays the recent tail, so the view restarts on open.
  useEffect(() => {
    let buffer = "";
    const source = new EventSource(`/api/servers/${server.id}/logs/stream`);
    source.onopen = () => { setConnected(true); buffer = ""; pausedBuffer.current = []; setBufferedCount(0); setLines([]); };
    source.onmessage = (event) => {
      buffer += JSON.parse(event.data) as string;
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";
      if (parts.length) append(parts.map((text) => ({ id: nextId.current++, kind: "log" as const, text: text.replace(/\r/g, "") })));
    };
    source.addEventListener("end", () => { setConnected(false); source.close(); });
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) setConnected(false); };
    return () => source.close();
  }, [server.id, streamKey, append]);

  // Keep following new output only while the reader is at the bottom.
  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    if (atBottom) node.scrollTop = node.scrollHeight;
  }, [lines, atBottom]);
  function onScroll() {
    const node = logRef.current;
    if (!node) return;
    const near = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
    setAtBottom(near);
    setLeftBottomAt(near ? null : (current) => current ?? lines.length);
  }
  function jumpToBottom() { const node = logRef.current; if (node) node.scrollTop = node.scrollHeight; setAtBottom(true); setLeftBottomAt(null); }
  const unseen = leftBottomAt === null ? 0 : lines.length - leftBottomAt;

  function togglePause() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next && pausedBuffer.current.length) { const buffered = pausedBuffer.current; pausedBuffer.current = []; setBufferedCount(0); setLines((current) => [...current, ...buffered].slice(-MAX_LINES)); }
  }

  const readHistory = useCallback((): string[] => { try { return JSON.parse(storageGet(historyKey) || "[]") as string[]; } catch { return []; } }, [historyKey]);

  async function send(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const text = (override ?? command).trim().replace(/^\/+/, "");
    if (!text) return;
    setSending(true);
    append(makeLines(`> ${text}`, "command"));
    try {
      const result = await api<{ output: string }>(`/api/servers/${server.id}/console`, { method: "POST", body: JSON.stringify({ command: text }) });
      if (result.output) append(makeLines(result.output, "reply"));
      const history = [text, ...readHistory().filter((item) => item !== text)].slice(0, 50);
      storageSet(historyKey, JSON.stringify(history));
      historyIndex.current = -1;
      if (!override) setCommand("");
    } catch (error) {
      append(makeLines(errorMessage(error, "Command failed."), "error"));
      toast.error(errorMessage(error, "Command failed."));
    } finally { setSending(false); jumpToBottom(); inputRef.current?.focus(); }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const history = readHistory();
    if (event.key === "ArrowUp" && history.length) {
      event.preventDefault();
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1);
      setCommand(history[historyIndex.current]);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      historyIndex.current = Math.max(historyIndex.current - 1, -1);
      setCommand(historyIndex.current === -1 ? "" : history[historyIndex.current]);
    } else if (event.key === "Tab" && server.players.length) {
      // Complete the last word against online player names.
      const match = /(\S*)$/.exec(command);
      const partial = match?.[1] || "";
      const found = server.players.find((name) => partial && name.toLowerCase().startsWith(partial.toLowerCase()));
      if (found) { event.preventDefault(); setCommand(command.slice(0, command.length - partial.length) + found + " "); }
    }
  }

  function runQuick(item: (typeof QUICK_COMMANDS)[number]) {
    if (item.fill) { setCommand(item.command); window.setTimeout(() => { const input = inputRef.current; if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }, 0); }
    else void send(undefined, item.command);
  }

  async function copyRecent() {
    const text = lines.slice(-200).map((line) => line.text).join("\n");
    try { await navigator.clipboard.writeText(text); toast.success("Copied the last 200 lines"); }
    catch { toast.error("Couldn't copy to the clipboard."); }
  }

  const visible = useMemo(() => lines.filter((line) => (showRconNoise || !RCON_NOISE.test(line.text)) && (!filter || line.text.toLowerCase().includes(filter.toLowerCase()))), [lines, filter, showRconNoise]);

  return <div className="flex h-[calc(100dvh-26rem)] min-h-[18rem] flex-col gap-2 md:h-[calc(100dvh-21rem)] md:min-h-[28rem]">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter output" aria-label="Filter console output" className="h-8 pl-8" />
      </div>
      <span className={cn("flex items-center gap-1.5 text-xs", connected ? "text-success" : "text-muted-foreground")}><span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-muted-foreground")} />{connected ? "Live" : running ? "Connecting…" : "Server stopped"}</span>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => setShowRconNoise(!showRconNoise)} aria-pressed={showRconNoise} title="Lines logged when the panel checks the server over RCON">{showRconNoise ? "Hide RCON lines" : "Show RCON lines"}</Button>
        <Button variant="outline" size="sm" onClick={togglePause} aria-pressed={paused}>{paused ? <><Play />Resume{bufferedCount ? ` (${bufferedCount})` : ""}</> : <><Pause />Pause</>}</Button>
        <Button variant="outline" size="sm" onClick={() => void copyRecent()} disabled={!lines.length}><ClipboardCopy /><span className="hidden sm:inline">Copy last 200</span></Button>
      </div>
    </div>
    <div className="relative min-h-0 flex-1">
      <div ref={logRef} onScroll={onScroll} role="log" aria-label={`${server.name} console`} aria-live="off" tabIndex={0}
        className="console absolute inset-0 overflow-auto rounded-xl border border-border p-3 text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4">
        {visible.length ? visible.map((line) => <div key={line.id} className={lineClass(line)}>{highlight(line.text, filter) || " "}</div>)
          : <p className="text-[#a1a1aa]">{filter ? "No lines match the filter." : running ? "Waiting for output…" : "The server is stopped. Its last output appears here; start it to see new output."}</p>}
      </div>
      {!atBottom && <Button size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg" onClick={jumpToBottom}><ArrowDown />{unseen > 0 ? `${unseen} new line${unseen === 1 ? "" : "s"}` : "Jump to latest"}</Button>}
    </div>
    {!can.console ? <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">You can watch the output. Sending commands needs the Operator role.</p> : <>
    <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5" aria-label="Quick commands">
      {quickCommands.map((item) => <button key={item.label} type="button" disabled={!running || sending} onClick={() => runQuick(item)} className="shrink-0 rounded-full border border-border px-3 py-1 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">{item.label}</button>)}
    </div>
    <form onSubmit={send} className="flex gap-2">
      <div className="relative min-w-0 flex-1">
        <CommandIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input ref={inputRef} className="pl-9 font-mono" value={command} onChange={(event) => { setCommand(event.target.value); historyIndex.current = -1; }} onKeyDown={onKeyDown}
          placeholder={running ? "Type a command…" : "Start the server to send commands"} aria-label="Console command" aria-describedby="console-help"
          disabled={!running} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="send" />
      </div>
      <Button type="submit" disabled={!command.trim() || !running || sending} aria-label="Send command"><SendHorizontal /><span className="hidden sm:inline">Send</span></Button>
    </form>
    <p id="console-help" className="hidden text-xs text-muted-foreground sm:block">Enter sends · ↑/↓ recall earlier commands · Tab completes player names · a leading / is optional</p>
    </>}
  </div>;
}
