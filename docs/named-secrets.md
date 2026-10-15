# Named secrets in the terminal

Press **Ctrl+Q** in an attached rich terminal to save a named password to your
Cuna Workspace vault. This is one simultaneous chord, with no sequential prefix.
The orange local popout has only **Secret Name** and **Password**. It requires a
current writer seat, a Workspace-bound session and isolated rich mode; plain mode
refuses collection. The API must support named-secret storage.

## Enter and save

- Use ↑/↓, Tab or Shift+Tab to move between the two fields. Clicking a field
  focuses it when terminal mouse reporting is supported.
- Passwords display one `*` per Unicode code point. Click **show** to reveal the
  value locally and **hide** to mask it again. Reveal resets on submission or
  closing. Control characters are escaped in the revealed display.
- Enter submits; Escape cancels unsent editing. Once a write has been dispatched,
  closing cannot undo it. Read the 0.1.8 validation limitation below.

Names are case-sensitive ASCII identifiers: a letter first, then letters,
digits, `.`, `_` or `-`, up to 64 characters. Passwords must be nonempty valid
UTF-8, up to 4096 bytes. Internal reserved names are refused. Existing names are
never overwritten. Saving a secret
does **not** grant any agent or Machine access to it.

The provider process keeps running while its current view updates behind the
popout. Editing expires two minutes after opening and clears the mutable value.
Each validation, write or confirmation request has a ten-second bound. Resize to
at least 30 columns by 8 rows to edit; shrinking clears unsent input and does not
restore it when enlarged.

## Paste and shortcut requirements

Unicode, Tab and CR/LF line breaks are supported through trustworthy host
bracketed-paste framing. Finish the paste before pressing Enter. Terminal control
sequences are unsupported. Raw terminal bytes cannot distinguish embedded paste
delimiters from host framing or prove that Enter was physically pressed.
Detectable ambiguity is refused, including extra input in a paste-end callback;
cancel and re-enter instead of saving a truncated value. The 0.1.8 asynchronous
validation exception is described below.

Ctrl+Q reserves direct XON for Cuna; `Ctrl+]` then `q` still sends XON remotely.
Host flow control or custom provider bindings can intercept Ctrl+Q before Cuna
receives it. Correct that binding and verify support on the actual terminal
before entering a password. A byte-level test does not establish support on
every physical host.

## Confirm or recover an operation

“Saved in Cuna” appears only after a GET for the same operation verifies its
committed receipt. A lost response remains **unknown**. Enter in that state checks
the same operation without another write; do not resubmit with a new identity.

If an operation is still in flight or unknown at orderly detach or process exit,
Cuna prints a safe recovery command:

```sh
cuna secrets operation OPERATION_ID --json
```

Use the ID from that notice. This command reads metadata using the current
account; it needs no running process, Machine or writer seat and does not reveal
the password. An unverified or absent response is not proof that no write
occurred. Closing the dialog never rolls back a committed write. An abrupt
process or OS failure may prevent the recovery notice from being printed.

Input is captured locally rather than sent as provider terminal input. Mutable
buffers are cleared, but immutable JavaScript strings, displayed revealed text
and network copies cannot be guaranteed erased from memory. This feature does
not protect against host screen capture, clipboard inspection or a compromised
operating system. Use reveal only where the local display is private.

## Known limitations in 0.1.8

The published npm 0.1.8 package has two known issues. Source corrections are listed
under [Unreleased](../CHANGELOG.md#unreleased); installing 0.1.8 does not include
them.

1. **Input during pending validation can still dispatch.** While “Checking vault
   authority…” is visible, late invalid paste framing or an Escape cancellation
   can race authority preparation. Finish pasting before Enter and do not type
   or paste during validation. If cancellation races that stage, check the
   original operation's result rather than assuming cancellation prevented it.
2. **Connection-change feedback can contradict a known receipt.** After a saved
   or rejected operation, losing the writer seat or connection can display
   “no write sent”. If an operation ID was printed, use the metadata GET above.
   Otherwise check your Cuna vault before attempting another save; a confirmed
   receipt is not undone by a later connection change.

These workarounds reduce exposure to the observed paths; they do not make
arbitrary terminal framing safe or turn an unknown outcome into a refusal.
