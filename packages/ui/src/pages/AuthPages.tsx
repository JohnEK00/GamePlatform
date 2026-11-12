import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { Alert, Spinner } from "../components/common";
import { Logo } from "../components/Layout";
import { errorMessage, useDocumentTitle } from "../util";

/** Only allow in-app relative redirects. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export function LoginPage() {
  const { user, login } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  useDocumentTitle("Log in");
  const next = safeNext(params.get("next"));
  const [form, setForm] = useState({ login: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user && !busy) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login({ login: form.login.trim(), password: form.password });
      toast.success(`Welcome back, ${u.displayName || u.username}!`);
      navigate(next, { replace: true });
    } catch (err) {
      setError(isApiError(err) && err.status === 401 ? "Wrong username/email or password." : errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="pf-container pf-page pf-auth">
      <form className="pf-panel pf-auth__card pf-form" onSubmit={submit}>
        <Logo />
        <h1>Log in</h1>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-login">
            Username or email
          </label>
          <input id="pf-login" className="pf-input" autoComplete="username" required autoFocus value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-password">
            Password
          </label>
          <input id="pf-password" className="pf-input" type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        {error && <Alert>{error}</Alert>}
        <button type="submit" className="pf-btn pf-btn--primary pf-btn--block" disabled={busy}>
          {busy ? <Spinner size={14} /> : null} Log in
        </button>
        <p className="pf-muted pf-small pf-center">
          New here? <Link to={`/register${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link>
        </p>
      </form>
    </div>
  );
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

export function RegisterPage() {
  const { user, register } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  useDocumentTitle("Sign up");
  const next = safeNext(params.get("next"));
  const [form, setForm] = useState({ username: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  if (user && !busy) return <Navigate to={next} replace />;

  const usernameErr = !USERNAME_RE.test(form.username) ? "3–24 characters: letters, numbers and underscores." : null;
  const emailErr = !/^\S+@\S+\.\S+$/.test(form.email) ? "Enter a valid email address." : null;
  const passwordErr = form.password.length < 8 ? "At least 8 characters." : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (usernameErr || emailErr || passwordErr) return;
    setBusy(true);
    setError(null);
    try {
      const u = await register({ username: form.username, email: form.email.trim(), password: form.password });
      toast.success(`Welcome to the arcade, ${u.username}!`);
      navigate(next, { replace: true });
    } catch (err) {
      setError(isApiError(err) && err.status === 409 ? "That username or email is already taken." : errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="pf-container pf-page pf-auth">
      <form className="pf-panel pf-auth__card pf-form" onSubmit={submit} noValidate>
        <Logo />
        <h1>Create your account</h1>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-reg-username">
            Username
          </label>
          <input id="pf-reg-username" className="pf-input" autoComplete="username" autoFocus value={form.username} aria-invalid={(touched && !!usernameErr) || undefined} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <span className={touched && usernameErr ? "pf-field__error" : "pf-field__hint"}>{usernameErr && touched ? usernameErr : "3–24 characters: letters, numbers and underscores."}</span>
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-reg-email">
            Email
          </label>
          <input id="pf-reg-email" className="pf-input" type="email" autoComplete="email" value={form.email} aria-invalid={(touched && !!emailErr) || undefined} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          {touched && emailErr && <span className="pf-field__error">{emailErr}</span>}
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-reg-password">
            Password
          </label>
          <input id="pf-reg-password" className="pf-input" type="password" autoComplete="new-password" value={form.password} aria-invalid={(touched && !!passwordErr) || undefined} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <span className={touched && passwordErr ? "pf-field__error" : "pf-field__hint"}>At least 8 characters.</span>
        </div>
        {error && <Alert>{error}</Alert>}
        <button type="submit" className="pf-btn pf-btn--primary pf-btn--block" disabled={busy}>
          {busy ? <Spinner size={14} /> : null} Sign up
        </button>
        <p className="pf-muted pf-small pf-center">
          Already have an account? <Link to={`/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}>Log in</Link>
        </p>
      </form>
    </div>
  );
}
