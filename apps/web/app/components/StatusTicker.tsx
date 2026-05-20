"use client";

import { useEffect, useRef } from "react";

type Event = { label: string; cls: "ok" | "warn"; details: string[] };

const accounts = [
  "fastmail/jordan",
  "rackspace/billing",
  "rackspace/billing",
  "zoho/support",
  "fastmail/jordan",
  "fastmail/jordan",
  "rackspace/billing",
  "zoho/support"
];

const events: Event[] = [
  { label: "IDLE", cls: "ok", details: ["INBOX +0", "INBOX +1", "INBOX +0", "Sent +0"] },
  {
    label: "SYNC",
    cls: "ok",
    details: ["INBOX → 3 new", "INBOX → 1 new", "Sent → 1 new", "[Receipts] → 2 new"]
  },
  {
    label: "DONE",
    cls: "ok",
    details: ["3 msgs · 188ms", "1 msg · 92ms", "2 msgs · 241ms", "5 msgs · 410ms"]
  },
  {
    label: "FETCH",
    cls: "ok",
    details: ["body uid 48223", "body uid 48224", "body uid 48225", "attachment uid 12044"]
  },
  { label: "IDLE", cls: "ok", details: ["INBOX +0", "[Archive] +0"] },
  {
    label: "PUSH",
    cls: "ok",
    details: ["flag \\Seen → uid 48221", "flag \\Flagged → uid 48202"]
  },
  { label: "BACKOFF", cls: "warn", details: ["retry in 38s", "retry in 51s", "retry in 22s"] },
  { label: "SYNC", cls: "ok", details: ["[Receipts] → 0", "INBOX → 0"] }
];

function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

export default function StatusTicker() {
  const tickerRef = useRef<HTMLDivElement | null>(null);
  const msgCountRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const ticker = tickerRef.current;
    const msgCount = msgCountRef.current;
    if (!ticker) return;

    const clock = new Date();
    clock.setHours(13, 42, 33, 0);

    let loop: ReturnType<typeof setTimeout> | undefined;

    function tick() {
      if (!ticker) return;
      clock.setSeconds(clock.getSeconds() + 1 + Math.floor(Math.random() * 7));
      const ts =
        "[" +
        pad(clock.getHours()) +
        ":" +
        pad(clock.getMinutes()) +
        ":" +
        pad(clock.getSeconds()) +
        "]";
      const acct = accounts[Math.floor(Math.random() * accounts.length)];
      const ev = events[Math.floor(Math.random() * events.length)];
      const detail = ev.details[Math.floor(Math.random() * ev.details.length)];

      const row = document.createElement("div");
      row.className = "row new";
      row.innerHTML =
        '<span class="ts">' +
        ts +
        "</span>" +
        "<span>" +
        acct +
        "</span>" +
        '<span class="' +
        ev.cls +
        '">' +
        ev.label +
        "</span>" +
        '<span class="dim">' +
        detail +
        "</span>";

      ticker.appendChild(row);
      setTimeout(() => row.classList.remove("new"), 400);
      while (ticker.children.length > 5) {
        ticker.removeChild(ticker.firstChild as ChildNode);
      }

      if (msgCount && (ev.label === "SYNC" || ev.label === "DONE" || ev.label === "FETCH")) {
        const current = parseInt(msgCount.textContent?.replace(/,/g, "") ?? "0", 10);
        msgCount.textContent = (current + 1 + Math.floor(Math.random() * 4)).toLocaleString();
      }
    }

    function schedule() {
      const delay = 2500 + Math.floor(Math.random() * 3000);
      loop = setTimeout(() => {
        tick();
        schedule();
      }, delay);
    }
    const initial = setTimeout(schedule, 1800);

    const onVisibility = () => {
      if (document.hidden) {
        if (loop) clearTimeout(loop);
      } else {
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearTimeout(initial);
      if (loop) clearTimeout(loop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="status-tail">
      <div className="head">
        <span className="br">~/supamail</span> <span className="pr">$</span>{" "}
        <span className="cmd">supamail tail --status</span>
      </div>
      <div className="body" ref={tickerRef}>
        <div className="row">
          <span className="ts">[13:42:18]</span>
          <span>fastmail/jordan</span>
          <span className="ok">IDLE</span>
          <span className="dim">INBOX +0</span>
        </div>
        <div className="row">
          <span className="ts">[13:42:21]</span>
          <span>rackspace/billing</span>
          <span className="ok">SYNC</span>
          <span className="dim">INBOX → 12 new</span>
        </div>
        <div className="row">
          <span className="ts">[13:42:24]</span>
          <span>rackspace/billing</span>
          <span className="ok">DONE</span>
          <span className="dim">12 msgs · 312ms</span>
        </div>
        <div className="row">
          <span className="ts">[13:42:31]</span>
          <span>zoho/support</span>
          <span className="warn">BACKOFF</span>
          <span className="dim">retry in 42s</span>
        </div>
        <div className="row">
          <span className="ts">[13:42:33]</span>
          <span>fastmail/jordan</span>
          <span className="ok">FETCH</span>
          <span className="dim">body uid 48222</span>
        </div>
      </div>
      <div className="foot">
        <span>
          <b className="live">●</b> <b>3</b> accounts
        </span>
        <span>
          <b ref={msgCountRef}>184,221</b> messages mirrored
        </span>
        <span>
          overall lag <b>12s</b>
        </span>
      </div>
    </div>
  );
}
