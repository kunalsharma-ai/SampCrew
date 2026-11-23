import { pickWelcomeScene, WELCOME_COPY, WELCOME_SCENE_COOKIE, type WelcomeScene } from '@crew/contracts';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { ApiError } from '../src/lib/api';
import { type SignInStep, useSession } from '../src/lib/session';
import { kv, secureStorageAvailable } from '../src/lib/storage';
import { Button, Card, Field, ListItem, Notice, Screen, Text } from '../src/ui';
import { WelcomeHero } from '../src/ui/welcome';

/**
 * Sign-in: email and password, then a 6-digit code when two-step sign-in is on, then a workspace if there are several.
 * Or single sign-on: the work email picks the workspace's identity provider, which opens in the system browser.
 */
export default function Login() {
  const { api, signIn, signInWithSso, verifyMfa, setInitialPassword, chooseWorkspace, notice } = useSession();
  const [sso, setSso] = useState(false);
  /** Forgot password: ask for the email, then the 6-digit code from it with a new password. */
  const [forgot, setForgot] = useState<null | 'email' | 'code'>(null);
  const [resetCode, setResetCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [step, setStep] = useState<SignInStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Tick or cross in the boxes: the password was wrong (cross, the box shakes) or right (tick). */
  const [verdict, setVerdict] = useState<'ok' | 'bad' | null>(null);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  // The email gets a tick once it is a complete address, and a cross once an @ is typed but it is not complete yet.
  const emailCheck: 'ok' | 'bad' | null = !email ? null : emailOk ? 'ok' : email.includes('@') ? 'bad' : null;
  // The level's welcome: asked for in the link (crew://login?space=hr), else the last level signed in to on this phone.
  const params = useLocalSearchParams<{ space?: string }>();
  const [scene, setScene] = useState<WelcomeScene>(() => pickWelcomeScene(params.space, null));
  useEffect(() => {
    if (params.space) return;
    void kv.get(WELCOME_SCENE_COOKIE).then((v) => setScene(pickWelcomeScene(null, v))).catch(() => undefined);
  }, [params.space]);

  const run = async (fn: () => Promise<SignInStep>) => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setVerdict(null);
    try {
      const next = await fn();
      if (next.step !== 'cancelled' && next.step !== 'redirected') setVerdict('ok');
      if (next.step === 'cancelled') setError('Single sign-on was cancelled.');
      else if (next.step === 'redirected') return; // the tab is on its way to the identity provider
      else if (next.step !== 'done') setStep(next);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.status === 429 ? 'Too many attempts. Wait a minute and try again.' : e.code === 'sso_required' ? 'Your workspace signs in with single sign-on. Use the button below.' : e.message);
        if (e.code === 'sso_required') setSso(true);
        else if (e.status === 401) setVerdict('bad');
        setFieldErrors(e.fieldErrors);
      } else setError('Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = () => {
    const errs: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) errs.email = 'Enter your work email';
    if (!password) errs.password = 'Enter your password';
    if (Object.keys(errs).length) return setFieldErrors(errs);
    void run(() => signIn(email.trim().toLowerCase(), password, workspace.trim() || undefined));
  };

  /** Any of the forgot-password calls: shows the API's own message, or a plain one when offline. */
  const runReset = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.status === 429 ? 'Too many attempts. Wait a minute and try again.' : e.message);
        setFieldErrors(e.fieldErrors);
      } else setError('Could not reach SampCrew. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const requestReset = () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setFieldErrors({ email: 'Enter your work email' });
    void runReset(async () => {
      const r = await api.publicRequest<{ message: string }>('POST', '/auth/password-reset/request', { email: email.trim().toLowerCase() });
      setInfo(r.message);
      setForgot('code');
    });
  };

  const completeReset = () => {
    const errs: Record<string, string> = {};
    if (!/^\d{6}$/.test(resetCode)) errs.code = 'Enter the 6-digit code from the email';
    if (!newPassword) errs.newPassword = 'Choose a new password';
    else if (newPassword !== confirmPassword) errs.confirmPassword = 'The two passwords do not match';
    if (Object.keys(errs).length) return setFieldErrors(errs);
    void runReset(async () => {
      const r = await api.publicRequest<{ message: string }>('POST', '/auth/password-reset/complete', { email: email.trim().toLowerCase(), code: resetCode, newPassword });
      setForgot(null);
      setResetCode('');
      setNewPassword('');
      setConfirmPassword('');
      setPassword('');
      setInfo(r.message);
    });
  };

  const submitSso = () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setFieldErrors({ email: 'Enter your work email' });
    void run(() => signInWithSso(email.trim().toLowerCase()));
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <WelcomeHero scene={scene} onChoose={step ? undefined : setScene} />
        <Text size={22} weight="800" style={{ marginTop: 4, letterSpacing: -0.4 }} testID="login-title">{WELCOME_COPY[scene].formTitle}</Text>
        <Text muted>Welcome back. Use your work email.</Text>
        {notice && <Notice tone="warn">{notice}</Notice>}
        {!secureStorageAvailable && (
          <Notice tone="warn" testID="web-preview-notice">
            Browser preview: your sign-in is kept in this browser&apos;s storage, not in a phone keychain. Use the iOS or Android app for everyday use.
          </Notice>
        )}
        {error && <Notice tone="danger" testID="login-error">{error}</Notice>}
        {info && !error && <Notice tone="info" testID="login-info">{info}</Notice>}
        <Card>
          {!step && forgot === 'email' && (
            <>
              <Text weight="600">Forgot your password?</Text>
              <Text muted size={14}>Enter the email you sign in with. We email you a 6-digit code (and a link for the web) to choose a new password.</Text>
              <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" error={fieldErrors.email} onSubmitEditing={requestReset} testID="forgot-email" />
              <Button title="Send code" onPress={requestReset} busy={busy} testID="forgot-send" />
              <Button title="Back to sign in" kind="secondary" onPress={() => { setForgot(null); setError(null); setInfo(null); }} />
            </>
          )}
          {!step && forgot === 'code' && (
            <>
              <Text weight="600">Enter your code</Text>
              <Text muted size={14}>Type the 6-digit code from the email to {email.trim()} and choose a new password. It works for 30 minutes.</Text>
              <Field label="6-digit code" value={resetCode} onChangeText={(v) => setResetCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" error={fieldErrors.code} testID="forgot-code" />
              <Field label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" hint="12+ characters with three of: lowercase, uppercase, numbers, symbols" error={fieldErrors.newPassword} testID="forgot-new-password" />
              <Field label="Confirm new password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" error={fieldErrors.confirmPassword} testID="forgot-confirm-password" />
              <Button title="Save new password" onPress={completeReset} busy={busy} testID="forgot-save" />
              <Button title="Send a new code" kind="secondary" onPress={requestReset} disabled={busy} />
              <Button title="Back to sign in" kind="secondary" onPress={() => { setForgot(null); setError(null); setInfo(null); }} />
            </>
          )}
          {!step && !forgot && sso && (
            <>
              <Text weight="600">Single sign-on</Text>
              <Text muted size={14}>Your work email takes you to your organisation&apos;s sign-in page. You come back here when it is done.</Text>
              <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" error={fieldErrors.email} onSubmitEditing={submitSso} />
              <Button title="Continue" onPress={submitSso} busy={busy} testID="sso-continue" />
              <Button title="Use a password instead" kind="secondary" onPress={() => { setSso(false); setError(null); }} />
            </>
          )}
          {!step && !forgot && !sso && (
            <>
              <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" error={fieldErrors.email} check={emailCheck} testID="login-email" />
              <Field label="Password" value={password} onChangeText={(v) => { setPassword(v); if (verdict === 'bad') setVerdict(null); }} secureTextEntry autoComplete="current-password" textContentType="password" error={fieldErrors.password} onSubmitEditing={submitPassword} check={verdict} testID="login-password" />
              <Field label="Workspace (optional)" help="field.workspace" value={workspace} onChangeText={setWorkspace} autoCapitalize="none" hint="Only needed if your account is in more than one workspace." error={fieldErrors.tenantSlug} />
              <Button title="Sign in" onPress={submitPassword} busy={busy} />
              <Button title="Forgot password?" kind="secondary" onPress={() => { setForgot('email'); setError(null); setInfo(null); setFieldErrors({}); }} testID="forgot-start" />
              <Button title="Sign in with single sign-on" kind="secondary" onPress={() => { setSso(true); setError(null); }} testID="sso-start" />
            </>
          )}
          {step?.step === 'mfa' && (
            <>
              <Text weight="600">Two-step sign-in</Text>
              <Text muted size={14}>Enter the 6-digit code from your authenticator app.</Text>
              <Field label="Code" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" error={fieldErrors.code} />
              <Button title="Verify" disabled={code.length !== 6} busy={busy} onPress={() => run(() => verifyMfa(step.mfaToken, code))} />
              <Button title="Back" kind="secondary" onPress={() => { setStep(null); setCode(''); }} />
            </>
          )}
          {step?.step === 'newPassword' && (
            <>
              <Text weight="600">Choose your password</Text>
              <Text muted size={14}>You signed in with a temporary password from HR. Choose your own to carry on.</Text>
              <Field label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" hint="12+ characters with three of: lowercase, uppercase, numbers, symbols" error={fieldErrors.newPassword} testID="new-password" />
              <Field label="Confirm new password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" error={fieldErrors.confirmPassword} testID="confirm-password" />
              <Button
                title="Save password and sign in"
                busy={busy}
                disabled={!newPassword}
                onPress={() => (newPassword !== confirmPassword ? setFieldErrors({ confirmPassword: 'The two passwords do not match' }) : run(() => setInitialPassword(step.changeToken, newPassword)))}
              />
              <Button title="Back" kind="secondary" onPress={() => { setStep(null); setNewPassword(''); setConfirmPassword(''); }} />
            </>
          )}
          {step?.step === 'workspace' && (
            <>
              <Text weight="600">Choose a workspace</Text>
              {step.workspaces.map((w) => (
                <ListItem key={w.id} title={w.name} subtitle={w.slug} onPress={() => run(() => chooseWorkspace(step.selectToken, w.id))} />
              ))}
              <Button title="Back" kind="secondary" onPress={() => setStep(null)} />
            </>
          )}
        </Card>
      </Screen>
    </KeyboardAvoidingView>
  );
}
