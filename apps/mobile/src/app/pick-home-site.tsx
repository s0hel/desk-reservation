/**
 * First run: which office do you work from (FR-1.9)?
 *
 * Asked once, and only when there is a real choice to make — `useHomeSite` reports
 * `needsChoosing` only for a tenant with more than one site and a user with no answer
 * recorded. A single-office tenant is never shown this, because "pick Berlin" is not
 * a question.
 *
 * This is a route behind a guard, not a modal and not an imperative redirect. The
 * app's routing is derived from state throughout (`app/_layout.tsx`), and the one
 * time it was not — deciding once on mount — signing out left the app sitting on
 * blank tabs. The same hole would open here the moment a home site were cleared
 * mid-session by an admin.
 *
 * There is deliberately no skip. The answer decides which building every other screen
 * is about, and a null one means the rest of the app falls back to guessing.
 */

import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/Button";
import { RefusalSheet } from "@/components/RefusalSheet";
import { SiteOption } from "@/components/SiteOption";
import { ProblemError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { refusal, type Refusal } from "@/lib/messages";
import { useHomeSite, useSetHomeSite } from "@/lib/site";
import { spacing, type, useThemedStyles, type Theme } from "@/lib/theme";

export default function PickHomeSite() {
  const { me } = useAuth();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { sites } = useHomeSite();

  const [chosen, setChosen] = useState<string | null>(null);
  const [problem, setProblem] = useState<Refusal | null>(null);

  // No `onDone`: success flips `needsChoosing` and the guard unmounts this screen,
  // so there is nothing left here to close.
  const save = useSetHomeSite();

  const first = me?.display_name?.trim().split(/\s+/)[0];

  return (
    <>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={{
          padding: spacing(2),
          paddingTop: insets.top + spacing(4),
          paddingBottom: insets.bottom + spacing(3),
        }}
      >
        <Text style={styles.display}>{first ? `Hello, ${first}` : "Hello"}</Text>
        <Text style={styles.lede}>
          Which office do you work from? This is the one the app opens on — you can be
          booked into any of them.
        </Text>

        <View style={styles.list}>
          {sites.map((site) => (
            <SiteOption
              key={site.id}
              site={site}
              selected={chosen === site.id}
              disabled={save.isPending}
              onPress={() => setChosen(site.id)}
            />
          ))}
        </View>

        {/* A confirm step here, unlike the Me tab's sheet: this screen is a gate the
            user cannot leave any other way, so tapping a row must be reversible
            before it commits. The sheet applies on tap because it is dismissable. */}
        <Button
          label="That's my office"
          busy={save.isPending}
          disabled={!chosen}
          onPress={() =>
            chosen &&
            save.mutate(chosen, {
              onError: (error) =>
                setProblem(
                  error instanceof ProblemError
                    ? refusal(error.violations, error.detail)
                    : refusal([], "Could not reach the server."),
                ),
            })
          }
          style={{ marginTop: spacing(2) }}
        />
        {/* Names the actual place, because "you can change this later" without one
            is the kind of reassurance that sends people hunting. */}
        <Text style={styles.footnote}>You can change this later under Me.</Text>
      </ScrollView>

      <RefusalSheet refusal={problem} onClose={() => setProblem(null)} />
    </>
  );
}

const makeStyles = (t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.color.ground },
  display: { ...type.display, color: t.color.ink },
  lede: { ...type.body, color: t.color.muted, marginTop: spacing(1) },
  list: { gap: spacing(1), marginTop: spacing(3) },
  footnote: {
    ...type.sub,
    color: t.color.muted,
    textAlign: "center" as const,
    marginTop: spacing(1.5),
  },
});
