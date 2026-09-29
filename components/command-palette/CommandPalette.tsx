"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AMBER, BG1, BORDER, DIM, MONO } from "@/lib/constants";

export type Command = {
  id: string;
  label: string;
  keywords: string[];
  action: () => void;
};

/**
 * Lightweight subsequence fuzzy matcher. Returns a score (higher is better)
 * or null when the query does not match the target. Consecutive matches and
 * matches at word boundaries score higher so results feel intuitive.
 */
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak += 1;
      score += 1 + streak;
      const prev = ti === 0 ? " " : t[ti - 1];
      if (prev === " " || prev === "-" || prev === "/") score += 3;
      qi += 1;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : null;
}

function matchCommand(query: string, cmd: Command): number | null {
  const trimmed = query.trim();
  if (!trimmed) return 0;
  const candidates = [cmd.label, ...cmd.keywords];
  let best: number | null = null;
  for (const c of candidates) {
    const s = fuzzyScore(trimmed, c);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

type Props = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
};

export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const scored: { cmd: Command; score: number }[] = [];
    for (const cmd of commands) {
      const score = matchCommand(query, cmd);
      if (score !== null) scored.push({ cmd, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [commands, query]);

  // Reset state whenever the palette is (re)opened.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Focus after paint so the input exists in the DOM.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Keep the active index within bounds as results change.
  useEffect(() => {
    setActiveIndex((i) => (i >= results.length ? 0 : i));
  }, [results.length]);

  const runCommand = useCallback(
    (cmd: Command | undefined) => {
      if (!cmd) return;
      onClose();
      cmd.action();
    },
    [onClose],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) =>
          results.length ? (i - 1 + results.length) % results.length : 0,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        runCommand(results[activeIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        // Trap focus inside the palette while open.
        e.preventDefault();
        inputRef.current?.focus();
      }
    },
    [results, activeIndex, runCommand, onClose],
  );

  // Scroll the active option into view as the user navigates.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "12vh",
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        style={{
          width: "min(560px, 92vw)",
          background: BG1,
          border: `1px solid ${BORDER}`,
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
          fontFamily: MONO,
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          placeholder="Type a command or search…"
          aria-label="Search commands"
          aria-controls="command-palette-list"
          aria-activedescendant={
            results[activeIndex] ? `cmd-${results[activeIndex].id}` : undefined
          }
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "14px 16px",
            background: "transparent",
            border: "none",
            borderBottom: `1px solid ${BORDER}`,
            color: "#fff",
            fontFamily: MONO,
            fontSize: 13,
            outline: "none",
          }}
        />
        <ul
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 6,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {results.length === 0 && (
            <li
              style={{
                padding: "12px 14px",
                fontSize: 11,
                color: DIM,
                letterSpacing: "0.06em",
              }}
            >
              no matching commands
            </li>
          )}
          {results.map((cmd, i) => (
            <li
              key={cmd.id}
              id={`cmd-${cmd.id}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => runCommand(cmd)}
              style={{
                padding: "10px 14px",
                fontSize: 12,
                cursor: "pointer",
                color: i === activeIndex ? "#fff" : "#bbb",
                background: i === activeIndex ? "rgba(245,166,35,0.14)" : "transparent",
                borderLeft: i === activeIndex ? `2px solid ${AMBER}` : "2px solid transparent",
                letterSpacing: "0.04em",
              }}
            >
              {cmd.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
