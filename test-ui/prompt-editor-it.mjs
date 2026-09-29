// IT — the prompts LIBRARY editor is a MODE, and the mode is entered and left cleanly.
//
// The bug behind this: editing a long prompt was unreachable. .pl-modal is a fixed-height overflow:hidden flex
// column whose only scrollers were the textarea and the list, so a tall editor pushed Save/Cancel past a
// clipped edge with nothing able to scroll them back, and the text itself was read through a 96px slot. The
// fix makes editing a mode — the modal settles, the browse surfaces stand down, the text box takes the rest.
//
// The GEOMETRY of that (box heights, what is inside the modal's visible box) is not assertable here — a fake
// DOM has no layout — and is gated in a real browser across four viewport heights by
// parity/probes/cdp-gate-promptscroll.cjs. What IS assertable here is the mode CONTRACT the CSS hangs off:
// the class goes on and comes off on every exit path, and the surfaces that competed for the space are the
// ones withdrawn. If this contract breaks, the CSS silently does nothing.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { openPromptLibrary } = await import("../public/js/ui/prompts.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modal = () => document.querySelector(".pl-modal");
const editor = () => document.querySelector(".pl-editor");
const title = () => { const t = document.querySelector(".pl-title"); return t ? t.textContent : null; };
const editing = () => { const m = modal(); return !!m && m._cls.has("editing"); };
const seed = (prompts) => store.applyEvent({ type: "config", config: { prompts } });
const P = [{ id: "p1", name: "Long one", text: "line\n".repeat(40) }, { id: "p2", name: "Short", text: "hi" }];

try {
  connectWs(); await sleep(5);
  seed([]);
  openPromptLibrary(); await sleep(5);
  ok("the empty library explains reusable project context", document.querySelector(".pl-empty-big").textContent === "Saved prompts" && /project introductions, links and instructions/.test(document.querySelector(".pl-empty-sub").innerHTML) && /<kbd>\/\/<\/kbd>/.test(document.querySelector(".pl-empty-sub").innerHTML));
  ok("the create action names what it creates", document.querySelector(".pl-newbtn").textContent.includes("New prompt"));
  openPromptLibrary(); await sleep(200);
  seed(P);
  openPromptLibrary(); await sleep(5);
  ok("the library opens", !!modal());
  ok("it opens in BROWSE mode, not editing", !editing() && !editor());
  ok("the header reads 'Prompts'", title() === "Prompts");

  // ── entering the mode ──
  document.querySelectorAll(".pl-row")[0].querySelector(".pl-edit")._fire("click", { stopPropagation() {} });
  ok("clicking edit opens the editor", !!editor());
  ok("...and puts the modal in editing mode (this is what the CSS keys off)", editing());
  ok("...and the header names the mode", title() === "Edit prompt");
  ok("the text box is loaded with the prompt", document.querySelector(".pl-ed-text").value === P[0].text);

  const textBox = document.querySelector(".pl-ed-text");
  const sample = '{{session_name}} {{ project_name }} {session_name} {{unknown}} {{session_name} <img src=x> {{\nproject_name\t}}';
  textBox.value = sample; textBox._fire("input");
  const mirror = document.querySelector(".pl-ed-mirror");
  ok("editor recognizes only resolver-supported tokens", (mirror.innerHTML.match(/class="pl-placeholder"/g) || []).length === 3);
  ok("highlighting leaves native textarea value untouched", textBox.value === sample && textBox.tagName === "TEXTAREA");
  ok("mirror is inaccessible inert text with escaped markup", mirror.getAttribute("aria-hidden") === "true" && mirror.innerHTML.includes('&lt;img') && !mirror.querySelector('img'));
  ok("visible help explains double braces and labels textarea", document.querySelector(".pl-ed-help").innerHTML.includes('{{session_name}}') && textBox.getAttribute("aria-describedby") === "pl-placeholder-help" && textBox.getAttribute("aria-label") === "Prompt text");
  textBox.scrollTop = 100; textBox.scrollLeft = 12; textBox._fire("scroll");
  ok("mirror tracks both native scroll axes", mirror.scrollTop === 100 && mirror.scrollLeft === 12);
  textBox._fire("compositionstart");
  ok("composition uses native visible text", document.querySelector(".pl-ed-field").classList.contains("composing"));
  textBox._fire("compositionend");
  ok("composition end restores highlighting without changing value", !document.querySelector(".pl-ed-field").classList.contains("composing") && textBox.value === sample);

  textBox.value = "{{session_name}"; textBox._fire("input");
  ok("incomplete placeholder is not recognized", !mirror.innerHTML.includes('class="pl-placeholder"'));
  textBox.value += "}"; textBox._fire("input");
  ok("closing brace recognizes placeholder immediately", mirror.innerHTML.includes('class="pl-placeholder"'));

  // ── leaving it: Cancel ──
  document.querySelector(".pl-ed-cancel")._fire("click");
  ok("Cancel closes the editor", !editor());
  ok("...and LEAVES the mode (a stuck class would hide the list for good)", !editing());
  ok("...and restores the header", title() === "Prompts");

  // ── New is its own mode label ──
  document.querySelector(".pl-newbtn")._fire("click");
  ok("New opens the editor in editing mode", !!editor() && editing());
  ok("...labelled as a new prompt, not an edit", title() === "New prompt");
  ok("...with empty fields", document.querySelector(".pl-ed-name").value === "" && document.querySelector(".pl-ed-text").value === "");

  // ── leaving it: Esc (the modal must survive; the editor goes first) ──
  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  ok("Esc closes the EDITOR, not the whole library", !editor() && !!modal());
  ok("...and leaves the mode", !editing());

  // ── leaving it: Save ──
  document.querySelectorAll(".pl-row")[0].querySelector(".pl-edit")._fire("click", { stopPropagation() {} });
  document.querySelector(".pl-ed-name").value = "Renamed";
  document.querySelector(".pl-ed-text").value = "new body";
  ws.clear();
  document.querySelector(".pl-ed-save")._fire("click");
  ok("Save persists through config.update", (() => { const m = ws.last("config.update");
    return m && m.config && Array.isArray(m.config.prompts) && m.config.prompts.some((p) => p.name === "Renamed" && p.text === "new body"); })());
  ok("Save closes the editor", !editor());
  ok("...and leaves the mode", !editing());

  // ── the help card and the editor are two cards after the same space: only one may be open ──
  document.querySelector(".pl-help-btn")._fire("click");
  ok("the help card opens in browse mode", !!document.querySelector(".pl-help"));
  document.querySelectorAll(".pl-row")[0].querySelector(".pl-edit")._fire("click", { stopPropagation() {} });
  ok("opening the editor dismisses the help card (it would re-overflow the editor)", !document.querySelector(".pl-help"));
  ok("and the editor is up in editing mode", !!editor() && editing());

  // ── a save with an empty field must NOT leave the mode half-exited ──
  document.querySelector(".pl-ed-text").value = "";
  document.querySelector(".pl-ed-save")._fire("click");
  ok("Save with an empty field keeps the editor open", !!editor());
  ok("...and stays in editing mode", editing());

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);
