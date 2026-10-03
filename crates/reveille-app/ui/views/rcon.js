// SPDX-License-Identifier: GPL-3.0-only

// The remote console, in the shared dialog.
//
// It sends one command at a time to the server's game port and shows what the server prints back.
// It does not need the server to be joinable, compatible or even in the current sweep: rcon is a
// connectionless exchange with a password, which is also why it is offered next to the controls
// that act on one server and not inside the join flow.
//
// The quick commands are the read-only ones. Anything that changes the server — map, kick, say —
// is typed on purpose.

import { errorText, sendRconCommand } from "../lib/api.js";
import { openDialog } from "../lib/dialog.js";
import { el } from "../lib/dom.js";
import { describeOutcome, rconMemory } from "../lib/rcon-session.js";

const QUICK_COMMANDS = ["status", "serverinfo", "listbans"];

/** Open the console for a live server row. */
export function openRconConsole(row) {
  const address = row.address;
  const name = row.server?.hostname || "(unnamed server)";
  let busy = false;
  let cursor = null;

  const passwordInput = el("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: false,
    value: rconMemory.password(address),
    "aria-label": "Rcon password",
    onkeydown: (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      commandInput.focus();
    },
  });

  const log = el("div", {
    className: "rcon__log data",
    role: "log",
    tabIndex: 0,
    "aria-label": "Console output",
    dataset: { placeholder: "What the server prints appears here." },
  });

  const commandInput = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Command, for example status",
    "aria-label": "Command",
    onkeydown: onCommandKey,
  });

  const sendButton = el(
    "button",
    { type: "button", className: "btn btn--primary", onclick: () => void run(commandInput.value) },
    "Send",
  );

  const quick = el(
    "div",
    { className: "rcon__quick" },
    QUICK_COMMANDS.map((command) =>
      el(
        "button",
        { type: "button", className: "btn btn--ghost btn--sm", onclick: () => void run(command) },
        command,
      ),
    ),
  );

  openDialog(
    "Remote console",
    el(
      "div",
      { className: "rcon" },
      el(
        "p",
        { className: "rcon__target" },
        el("strong", null, name),
        el("span", { className: "quiet data" }, address),
      ),
      el(
        "label",
        { className: "rcon__field" },
        el("span", { className: "rcon__label" }, "Rcon password"),
        el("span", { className: "field" }, passwordInput),
      ),
      el(
        "p",
        { className: "quiet" },
        "Sent unencrypted, as the game does. Kept in memory until Reveille closes, never saved.",
      ),
      log,
      quick,
      el("div", { className: "rcon__send" }, el("span", { className: "field" }, commandInput), sendButton),
    ),
  );
  (passwordInput.value ? commandInput : passwordInput).focus();

  function append(tone, text) {
    log.append(el("pre", { className: `rcon__entry rcon__entry--${tone}` }, text));
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(next) {
    busy = next;
    // `aria-disabled` rather than `disabled`, as everywhere in this interface: the button goes
    // busy while the caret is in the command box, and a disabled element cannot keep focus.
    sendButton.setAttribute("aria-disabled", next ? "true" : "false");
    sendButton.textContent = next ? "Sending…" : "Send";
  }

  async function run(raw) {
    const command = raw.trim();
    if (busy || !command) return;
    const password = passwordInput.value;
    if (!password) {
      append("error", "Enter the rcon password first.");
      passwordInput.focus();
      return;
    }

    setBusy(true);
    append("echo", `> ${command}`);
    rconMemory.remember(command);
    cursor = null;
    commandInput.value = "";

    let described;
    try {
      described = describeOutcome(await sendRconCommand(address, password, command));
    } catch (error) {
      described = { tone: "error", text: errorText(error), password: "unknown" };
    }
    setBusy(false);

    append(described.tone, described.text);
    if (described.password === "rejected") {
      rconMemory.forgetPassword(address);
      passwordInput.focus();
      passwordInput.select();
      return;
    }
    if (described.password === "accepted") rconMemory.rememberPassword(address, password);
    commandInput.focus();
  }

  function onCommandKey(event) {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void run(commandInput.value);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const step = rconMemory.step(cursor, event.key === "ArrowUp" ? -1 : 1);
    if (step.text === null) return;
    event.preventDefault();
    cursor = step.cursor;
    commandInput.value = step.text;
    commandInput.setSelectionRange(step.text.length, step.text.length);
  }
}
