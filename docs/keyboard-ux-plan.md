# Keyboard UX rollout

This branch starts a system-wide keyboard pass. The application already uses
Radix dialogs and other Radix controls for focus trapping, Tab navigation,
Escape, and focus restoration. `react-hotkeys-hook` manages application
shortcuts; native forms provide Enter submission within dialogs. No shortcut
library can infer which application action Enter should invoke safely.

## Interaction contract

- Tab and Shift+Tab reach every interactive control in a logical order.
- Escape closes the topmost dismissible surface and restores focus. A global
  shortcut must not also act on the underlying page.
- Enter activates the focused button or submits a single-line form when valid.
  It does not submit from a multiline editor, during IME composition, or while
  a request is pending.
- Destructive forms require their existing explicit confirmation condition.
  Opening a dialog or typing a partial confirmation cannot trigger deletion.
- Shortcuts are scoped to the active surface and do not override browser or
  editor shortcuts. Their labels are visible near the relevant controls.

## Rollout

1. Use the installed Radix primitives for dialog and menu keyboard behavior.
   Audit each existing dialog for initial focus, Escape, and focus restoration.
2. Use `react-hotkeys-hook` for page and application shortcuts. Keep them
   inactive while another modal owns the keyboard. This branch migrates global
   search and focus mode as the first two shortcuts.
3. Move dialog actions to native form submission one flow at a time. This
   branch converts the workspace reset dialog: Enter submits only after the
   exact confirmation word is entered, and Escape remains owned by Radix.
4. Audit the remaining dialog consumers in `src/app` and
   `src/components/foundry`. Prioritize creation, rename, approval, and delete
   flows. Replace ad hoc input key handlers with form submission where possible.
5. Verify with keyboard-only browser runs at desktop and mobile widths, then
   with a screen reader. Check nested surfaces, focus restoration, repeated key
   presses, disabled/loading states, and text editors before merge.

Do not add a global Enter handler: it could activate the wrong action in a
dialog, especially for destructive operations.
