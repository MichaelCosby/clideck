// Typing guard. An input frame with userActivity:true tells the engine a person is editing that session's prompt,
// so automatic asks hold off for a few seconds (the engine owns the deadline; nothing here ever clears it).
// Raw xterm data is never marked: it also carries the terminal's own protocol replies. Instead the trusted edit
// itself reports activity (empty data), and host insertions the person asked for carry the flag.
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "Hyper", "Super", "OS"]);
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

export const userInputFrame = (sessionId, data) => ({ type: "input", sessionId, data, userActivity: true });

// Keys that edit or navigate the prompt (characters, Enter, Backspace, arrows/history, Ctrl+ line editing).
// Excluded: lone modifiers, F-keys (CliDeck shortcuts), Cmd combos (browser/app shortcuts; Cmd+V arrives
// as a paste), Ctrl+F (opens terminal search) and IME keydowns, which the composition events report instead.
const findKey = (e) => e.ctrlKey && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "f";
export function isEditingKey(e) {
  return !!e.isTrusted && !e.metaKey && !e.isComposing && e.keyCode !== 229
    && !MODIFIERS.has(e.key) && !FUNCTION_KEY.test(e.key) && !findKey(e);
}
