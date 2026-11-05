import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { ApiError } from '../src/lib/api';
import { type SignInStep, useSession } from '../src/lib/session';
import { secureStorageAvailable } from '../src/lib/storage';
import { Button, Card, Field, ListItem, Notice, Screen, Text, Title } from '../src/ui';

/** Sign-in: email and password, then a 6-digit code when two-step sign-in is on, then a workspace if there are several. */
export default function Login() {
  const { signIn, verifyMfa, chooseWorkspace, notice } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [code, setCode] = useState('');
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
      if (next.step !== 'done') setStep(next);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.status === 429 ? 'Too many attempts. Wait a minute and try again.' : e.message);
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

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <View style={{ height: 40 }} />
        <Title>CREW</Title>
        <Text muted>Sign in to your workspace.</Text>
        {notice && <Notice tone="warn">{notice}</Notice>}
        {!secureStorageAvailable && (
          <Notice tone="warn" testID="web-preview-notice">
            Browser preview: your sign-in is kept in this browser&apos;s storage, not in a phone keychain. Use the iOS or Android app for everyday use.
          </Notice>
        )}
        {error && <Notice tone="danger" testID="login-error">{error}</Notice>}
        <Card>
          {!step && (
            <>
              <Field label="Work email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" error={fieldErrors.email} />
              <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" error={fieldErrors.password} onSubmitEditing={submitPassword} />
              <Field label="Workspace (optional)" value={workspace} onChangeText={setWorkspace} autoCapitalize="none" hint="Only needed if your account is in more than one workspace." error={fieldErrors.tenantSlug} />
              <Button title="Sign in" onPress={submitPassword} busy={busy} />
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
