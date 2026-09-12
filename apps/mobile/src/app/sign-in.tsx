import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text,
  TextInput, View,
} from "react-native";

import { ProblemError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, spacing } from "@/lib/theme";

export default function SignIn() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("priya.raman@example.com");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim());
      router.replace("/(tabs)");
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
        placeholderTextColor={colors.muted}
        style={styles.input}
        accessibilityLabel="Work email address"
      />

      <Pressable
        onPress={submit}
        disabled={busy}
        style={({ pressed }) => [styles.button, (pressed || busy) && { opacity: 0.7 }]}
        accessibilityRole="button"
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue</Text>}
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: spacing(3), justifyContent: "center" },
  brand: { color: colors.text, fontSize: 34, fontWeight: "700" },
  sub: { color: colors.muted, fontSize: 16, marginTop: spacing(0.5), marginBottom: spacing(3) },
  input: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 12,
    color: colors.text, fontSize: 16, padding: spacing(2),
  },
  button: {
    backgroundColor: colors.accent, borderRadius: 12, padding: spacing(2),
    alignItems: "center", marginTop: spacing(2),
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  error: { color: colors.danger, marginTop: spacing(2) },
  note: {
    marginTop: spacing(4), padding: spacing(2), backgroundColor: colors.card,
    borderRadius: 12, borderColor: colors.border, borderWidth: 1,
  },
  noteText: { color: colors.muted, fontSize: 13, lineHeight: 19 },
});
