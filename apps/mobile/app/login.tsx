import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, View } from 'react-native';
import { ApiError } from '../src/lib/api';
import { type SignInStep, useSession } from '../src/lib/session';
import { secureStorageAvailable } from '../src/lib/storage';
import { Button, Card, Field, ListItem, Notice, Screen, Text, useTheme } from '../src/ui';

/**
 * Sign-in: email and password, then a 6-digit code when two-step sign-in is on, then a workspace if there are several.
 * Or single sign-on: the work email picks the workspace's identity provider, which opens in the system browser.
 */
export default function Login() {
  const { signIn, signInWithSso, verifyMfa, setInitialPassword, chooseWorkspace, notice } = useSession();
  const [sso, setSso] = useState(false);
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

  const run = async (fn: () => Promise<SignInStep>) => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const next = await fn();
      if (next.step === 'cancelled') setError('Single sign-on was cancelled.');
      else if (next.step === 'redirected') return; // the tab is on its way to the identity provider
      else if (next.step !== 'done') setStep(next);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.status === 429 ? 'Too many attempts. Wait a minute and try again.' : e.code === 'sso_required' ? 'Your workspace signs in with single sign-on. Use the button below.' : e.message);
        if (e.code === 'sso_required') setSso(true);
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

  const submitSso = () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setFieldErrors({ email: 'Enter your work email' });
    void run(() => signInWithSso(email.trim().toLowerCase()));
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={{ height: 40 }} />
        <Brand />
        <Text size={26} weight="800" accessibilityRole="header" style={{ marginTop: 12, letterSpacing: -0.4 }}>Welcome back</Text>
        <Text muted>Sign in to your workspace.</Text>
        {notice && <Notice tone="warn">{notice}</Notice>}
        {!secureStorageAvailable && (
          <Notice tone="warn" testID="web-preview-notice">
            Browser preview: your sign-in is kept in this browser&apos;s storage, not in a phone keychain. Use the iOS or Android app for everyday use.
          </Notice>
        )}
        {error && <Notice tone="danger" testID="login-error">{error}</Notice>}
        <Card>
          {!step && sso && (
            <>
              <Text weight="600">Single sign-on</Text>
              <Text muted size={14}>Your work email takes you to your organisation&apos;s sign-in page. You come back here when it is done.</Text>
              <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" error={fieldErrors.email} onSubmitEditing={submitSso} />
              <Button title="Continue" onPress={submitSso} busy={busy} testID="sso-continue" />
              <Button title="Use a password instead" kind="secondary" onPress={() => { setSso(false); setError(null); }} />
            </>
          )}
          {!step && !sso && (
            <>
              <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" error={fieldErrors.email} />
              <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" error={fieldErrors.password} onSubmitEditing={submitPassword} />
              <Field label="Workspace (optional)" help="field.workspace" value={workspace} onChangeText={setWorkspace} autoCapitalize="none" hint="Only needed if your account is in more than one workspace." error={fieldErrors.tenantSlug} />
              <Button title="Sign in" onPress={submitPassword} busy={busy} />
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

/** The SampCrew logo ("People, simplified." by SAMPLEDGE), drawn for the light or dark theme. */
const LOGO = { light: require('../assets/logo-light.png'), dark: require('../assets/logo-dark.png') } as const;

function Brand() {
  const t = useTheme();
  // The artwork is 1458 x 384.
  return (
    <View testID="brand" accessible accessibilityRole="image" accessibilityLabel="SampCrew. People, simplified. By SAMPLEDGE">
      <Image source={t.mode === 'dark' ? LOGO.dark : LOGO.light} style={{ width: 243, height: 64 }} resizeMode="contain" />
    </View>
  );
}
