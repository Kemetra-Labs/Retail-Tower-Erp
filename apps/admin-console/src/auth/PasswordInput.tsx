import { Icon } from "@/components/icons/Icon";
import { useT } from "@/i18n";
/**
 * RT-971: a password input with a show-password toggle (canvas «تسجيل الدخول»).
 * The toggle is a real button inside the field's end: «إظهار كلمة المرور» /
 * "Show password", `aria-pressed` while the password is shown, `aria-controls`
 * the input. Its name never changes; the pressed state says which way it is.
 * It does not submit and keeps the 36px target (`--control-h`).
 *
 * The input has no placeholder: a row of dots says nothing a label doesn't.
 * Machine input, so it stays LTR (UX-11).
 */
import { useState } from "react";

export interface PasswordInputProps {
  id: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  describedBy?: string;
}

export function PasswordInput({
  id,
  name,
  autoComplete,
  disabled,
  invalid,
  required,
  describedBy,
}: Readonly<PasswordInputProps>): React.JSX.Element {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="password-input">
      <input
        className="input password-input__control"
        id={id}
        name={name}
        type={shown ? "text" : "password"}
        dir="ltr"
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize="off"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        required={required}
      />
      <button
        type="button"
        className="password-input__toggle"
        aria-label={t("auth.password.show")}
        aria-pressed={shown}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setShown((s) => !s)}
      >
        <Icon name={shown ? "conceal" : "reveal"} />
      </button>
    </div>
  );
}
