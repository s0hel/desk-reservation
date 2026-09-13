import { useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text,
  TextInput, View,
} from "react-native";

import { ProblemError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

export default function SignIn() {
  const { signIn } = useAuth();
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [email, setEmail] = useState("priya.raman@example.com");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // No navigation here: the route guard in _layout.tsx owns it, so signing in
      // and signing out go through exactly one mechanism.
      await signIn(email.trim());
    } catch (e) {
      // Phase 1 renders from violation codes instead of `detail` (TDD §11).
      setError(e instanceof ProblemError ? e.detail : "Could not reach the API");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <Text style={styles.brand}>Deskflow</Text>
      <Text style={styles.sub}>Sign in with your work email</Text>

      <TextInput
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        placeholder="you@company.com"
        placeholderTextColor={theme.color.muted}
        style={styles.input}
        accessibilityLabel="Work email address"
      />

      <Pressable
        onPress={submit}
        disabled={busy}
        style={({ pressed }) => [styles.button, (pressed || busy) && { opacity: 0.7 }]}
        accessibilityRole="button"
      >
        {busy ? (
          <ActivityIndicator color={theme.color.onAccent} />
        ) : (
          <Text style={styles.buttonText}>Continue</Text>
        )}
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.note}>
        <Text style={styles.noteText}>
          Phase 0 uses the development sign-in endpoint. The real flow is OIDC with the
          API acting as relying party (TDD §12.1) — no IdP is configured yet.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (t: Theme) => ({
  screen: {
    flex: 1,
    backgroundColor: t.color.ground,
    padding: spacing(3),
    justifyContent: "center" as const,
  },
  brand: { ...type.display, color: t.color.ink },
  sub: { ...type.body, color: t.color.muted, marginTop: spacing(0.5), marginBottom: spacing(3) },
  input: {
    ...t.card,
    ...type.body,
    color: t.color.ink,
    borderRadius: radius.m,
    padding: spacing(2),
  },
  button: {
    backgroundColor: t.color.accent,
    borderRadius: radius.pill,
    padding: spacing(2),
    alignItems: "center" as const,
    marginTop: spacing(2),
  },
  buttonText: { ...type.body, fontWeight: "600" as const, color: t.color.onAccent },
  error: { ...type.sub, color: t.color.danger, marginTop: spacing(2) },
  note: {
    marginTop: spacing(4),
    padding: spacing(2),
    backgroundColor: t.color.surfaceAlt,
    borderRadius: radius.m,
  },
  noteText: { ...type.sub, fontSize: 13, color: t.color.muted },
});
