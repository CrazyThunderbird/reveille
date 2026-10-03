// SPDX-License-Identifier: GPL-3.0-only

//! The remote console command.
//!
//! The password and the command are secrets in the same breath — a command can be
//! `set rconpassword …` — so neither is logged, counted in telemetry, or sent anywhere but the
//! server the player chose. Only the address and the shape of the outcome are written to the log.

use std::net::SocketAddrV4;

use reveille_core::discovery::{
    self, GamePort, RconCommand, RconError, RconPassword, RconReply, RconTiming,
};
use serde::Serialize;
use tracing::info;

/// What the console shows for one command. Always returned as data: a wrong password and a
/// silent server are things the player is told about, not failures of the app.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RconOutcome {
    /// The server answered. A refused password is still an answer; see `verdict`.
    Reply(RconReply),
    /// The password or command could not be sent, and nothing left this machine.
    Refused {
        /// Why, in words fit to show.
        reason: String,
    },
    /// The server said nothing in time. The command may still have run: a server answers after
    /// it has finished, and a map change takes seconds.
    NoAnswer,
    /// The network failed before an answer could arrive.
    Failed {
        /// The operating system's description.
        detail: String,
    },
}

/// Send one console command to a server's game port and return what it printed.
///
/// `address` is the server's `ip:port` as the list shows it, the game port rather than the query
/// port.
#[tauri::command]
pub async fn send_rcon_command(
    address: String,
    password: String,
    command: String,
) -> Result<RconOutcome, String> {
    let address = address
        .parse::<SocketAddrV4>()
        .map_err(|error| format!("Reveille could not read the address {address}: {error}"))?;
    if address.port() == 0 {
        return Err(format!("{address} has no game port to send a command to."));
    }
    let (password, command) = match (RconPassword::new(&password), RconCommand::new(&command)) {
        (Ok(password), Ok(command)) => (password, command),
        (Err(error), _) | (_, Err(error)) => {
            return Ok(RconOutcome::Refused {
                reason: error.to_string(),
            });
        }
    };

    let result = discovery::send_rcon(
        *address.ip(),
        GamePort::new(address.port()),
        &password,
        &command,
        RconTiming::default(),
    )
    .await;
    let outcome = outcome(result);
    info!(%address, outcome = outcome_label(&outcome), "remote console command");
    Ok(outcome)
}

fn outcome(result: Result<RconReply, RconError>) -> RconOutcome {
    match result {
        Ok(reply) => RconOutcome::Reply(reply),
        Err(RconError::Input(error)) => RconOutcome::Refused {
            reason: error.to_string(),
        },
        Err(RconError::Timeout) => RconOutcome::NoAnswer,
        Err(RconError::Network(source)) => RconOutcome::Failed {
            detail: source.to_string(),
        },
    }
}

fn outcome_label(outcome: &RconOutcome) -> &'static str {
    match outcome {
        RconOutcome::Reply(_) => "reply",
        RconOutcome::Refused { .. } => "refused",
        RconOutcome::NoAnswer => "no_answer",
        RconOutcome::Failed { .. } => "failed",
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use reveille_core::discovery::{
        RconError, RconInputError, RconReply, RconVerdict, RoundTripMillis,
    };
    use serde_json::json;

    use super::{RconOutcome, outcome};

    fn reply(output: &str, verdict: RconVerdict) -> RconReply {
        RconReply {
            output: output.to_owned(),
            verdict,
            packets: 1,
            truncated: false,
            round_trip: RoundTripMillis::new(42),
        }
    }

    #[test]
    fn a_reply_reaches_the_shell_flat_with_its_verdict() {
        let shown = serde_json::to_value(outcome(Ok(reply("ok\n", RconVerdict::WrongPassword))))
            .expect("outcome serializes");

        assert_eq!(
            shown,
            json!({
                "status": "reply",
                "output": "ok\n",
                "verdict": "wrong_password",
                "packets": 1,
                "truncated": false,
                "round_trip": 42,
            })
        );
    }

    #[test]
    fn silence_is_not_an_error_the_shell_has_to_catch() {
        let shown = serde_json::to_value(outcome(Err(RconError::Timeout))).expect("serializes");

        assert_eq!(shown, json!({ "status": "no_answer" }));
    }

    #[test]
    fn an_unsendable_input_says_why() {
        let shown =
            serde_json::to_value(outcome(Err(RconError::Input(RconInputError::EmptyCommand))))
                .expect("serializes");

        assert_eq!(
            shown,
            json!({ "status": "refused", "reason": "the command is empty" })
        );
    }

    #[test]
    fn a_socket_failure_carries_the_systems_own_words() {
        let failed = outcome(Err(RconError::Network(io::Error::other("unreachable"))));

        assert!(
            matches!(&failed, RconOutcome::Failed { detail } if detail == "unreachable"),
            "{failed:?}"
        );
    }
}
