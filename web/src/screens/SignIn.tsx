import { useId, useState, type FormEvent, type InputHTMLAttributes } from "react";
import { auth, authProblem, CHALLENGE_EXPIRED, challengeExpired, PASSWORD_RULES, passwordProblem } from "../lib/auth.ts";
import { Icon } from "../components/Icon.tsx";
import { Button, Swash } from "../components/ui.tsx";

export function SignIn({ onDone, note }: { onDone: () => void; note?: string | null }) {
  const [step, setStep] = useState<"credentials" | "new_password">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  function startAgain() {
    setStep("credentials");
    setFresh("");
    setPassword("");
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (step === "credentials") {
      if (!email.trim() || !password) {
        setError("Enter your email and password.");
        return;
      }
    } else {
      const problem = passwordProblem(fresh);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setBusy(true);
    try {
      const next = step === "credentials" ? await auth().signIn(email, password) : await auth().setNewPassword(fresh);
      if (next.kind === "new_password") {
        setStep("new_password");
        setPassword("");
      } else onDone();
    } catch (err) {
      if (step === "new_password" && challengeExpired(err)) {
        // The invitation challenge only lives a few minutes; retrying it can never work, so go back a step.
        startAgain();
        setError(CHALLENGE_EXPIRED);
      } else setError(authProblem(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin" id="main">
      <section className="signin__card glass glass--sage glass--refract" aria-labelledby={`${id}-t`}>
        <div className="brand brand--large" aria-hidden="true">
          <span className="brand__mark">
            C<span className="brand__dot" />
          </span>
          <span className="brand__name">
            Clip <em>Factory</em>
          </span>
        </div>
        <h1 className="signin__title" id={`${id}-t`}>
          {step === "credentials" ? (
            <>
              Long streams, <Swash>short</Swash> clips.
            </>
          ) : (
            <>
              Choose your <Swash>own</Swash> password.
            </>
          )}
        </h1>
        <p className="signin__lede">
          {step === "credentials"
            ? "Sign in once and stay signed in. The app only asks again after a month away."
            : "Your invitation password was temporary. Pick the one you will use from now on."}
        </p>
        {note ? (
          <p className="signin__note" role="status">
            <Icon name="info" size={18} />
            <span>{note}</span>
          </p>
        ) : null}
        <form className="signin__form" onSubmit={submit} noValidate>
          {step === "credentials" ? (
            <>
              <div className="field">
                <label className="field__label" htmlFor={`${id}-e`}>
                  Email
                </label>
                <input
                  id={`${id}-e`}
                  className="input"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!error && !email.trim()}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${id}-p`}>
                  Password
                </label>
                <PasswordInput
                  id={`${id}-p`}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor={`${id}-n`}>
                New password
              </label>
              <PasswordInput
                id={`${id}-n`}
                autoComplete="new-password"
                value={fresh}
                onChange={(e) => setFresh(e.target.value)}
                aria-describedby={`${id}-rules`}
              />
              <p className="field__hint" id={`${id}-rules`}>
                {PASSWORD_RULES}
              </p>
            </div>
          )}
          {error ? (
            <p className="form-error" role="alert">
              <Icon name="alert" size={18} />
              <span>{error}</span>
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" block loading={busy} iconAfter="chevronRight">
            {step === "credentials" ? "Sign in" : "Save password and continue"}
          </Button>
          {step === "new_password" ? (
            <Button type="button" variant="ghost" block onClick={startAgain} disabled={busy}>
              Start again
            </Button>
          ) : null}
        </form>
      </section>
    </main>
  );
}

/** A password field with a Show / Hide button, so a typo can be seen before it costs a sign-in attempt. */
function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password">
      <input {...props} className="input password__input" type={shown ? "text" : "password"} />
      <button
        type="button"
        className="password__toggle"
        aria-pressed={shown}
        aria-controls={props.id}
        onClick={() => setShown((v) => !v)}
      >
        <Icon name="eye" size={18} />
        <span>{shown ? "Hide" : "Show"}</span>
      </button>
    </div>
  );
}
