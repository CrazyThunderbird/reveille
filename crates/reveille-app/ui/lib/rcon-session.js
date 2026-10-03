// SPDX-License-Identifier: GPL-3.0-only

// What the remote console remembers while Reveille runs, and how it words what a server said.
//
// Nothing here touches storage. An rcon password is a credential for a server the player does not
// necessarily own, and a command can be `set rconpassword …`; a launcher whose job is joining
// games has no business leaving either on disk. Both live in this module's memory and go when
// the process does.

const HISTORY_LIMIT = 50;

export function createRconMemory() {
  const passwords = new Map();
  const history = [];

  return {
    password: (address) => passwords.get(address) ?? "",

    rememberPassword(address, password) {
      if (password) passwords.set(address, password);
    },

    forgetPassword(address) {
      passwords.delete(address);
    },

    remember(command) {
      if (!command || history.at(-1) === command) return;
      history.push(command);
      if (history.length > HISTORY_LIMIT) history.shift();
    },

    /**
     * Walk the history the way a shell does. `cursor` is where the player is now, with `null`
     * meaning the empty line below the newest command; `direction` is -1 for older, 1 for newer.
     * `text` is `null` when nothing should change.
     */
    step(cursor, direction) {
      if (direction < 0) {
        if (!history.length) return { cursor, text: null };
        const next = Math.max((cursor ?? history.length) - 1, 0);
        return { cursor: next, text: history[next] };
      }
      if (cursor === null) return { cursor, text: null };
      const next = cursor + 1;
      return next >= history.length
        ? { cursor: null, text: "" }
        : { cursor: next, text: history[next] };
    },
  };
}

export const rconMemory = createRconMemory();

const NO_ANSWER =
  "No answer. The command may still have run: a server replies after it has finished, " +
  "and a map change takes longer than Reveille waits.";

/**
 * One server answer as a console line.
 *
 * `tone` is `output`, `notice` or `error`. `password` says what the answer proves about the
 * password that was sent — `accepted`, `rejected` or `unknown` — so the console keeps one that
 * worked and drops one that did not, and never decides from a silence.
 */
export function describeOutcome(outcome) {
  switch (outcome?.status) {
    case "reply":
      return describeReply(outcome);
    case "refused":
      return { tone: "error", text: sentence(outcome.reason), password: "unknown" };
    case "no_answer":
      return { tone: "notice", text: NO_ANSWER, password: "unknown" };
    case "failed":
      return {
        tone: "error",
        text: `The network failed: ${String(outcome.detail ?? "").trim() || "no detail given"}.`,
        password: "unknown",
      };
    default:
      return { tone: "error", text: "Reveille got an answer it does not understand.", password: "unknown" };
  }
}

function describeReply(reply) {
  if (reply.verdict === "wrong_password") {
    return { tone: "error", text: "The server refused the password.", password: "rejected" };
  }
  if (reply.verdict === "password_not_set") {
    return {
      tone: "error",
      text: "This server has no rcon password, so it accepts no remote commands.",
      password: "rejected",
    };
  }
  const output = String(reply.output ?? "").replace(/\s+$/u, "");
  const cut = reply.truncated ? "\n… The server printed more than Reveille shows." : "";
  return output
    ? { tone: "output", text: output + cut, password: "accepted" }
    : { tone: "notice", text: `(no output)${cut}`, password: "accepted" };
}

/** A reason from the Rust side, which is lower-case and unpunctuated, read as a sentence. */
function sentence(reason) {
  const text = String(reason ?? "").trim();
  if (!text) return "Reveille could not send that.";
  const capital = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/u.test(capital) ? capital : `${capital}.`;
}
