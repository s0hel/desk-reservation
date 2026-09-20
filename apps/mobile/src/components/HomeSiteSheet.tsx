/**
 * Change your home office from the Me tab (FR-1.9).
 *
 * The counterpart to the first-run picker, and deliberately a different shape: that
 * one is a full screen because it gates the app, this one is a sheet because it is a
 * setting you came looking for. Both go through `useSetHomeSite`, so they cannot
 * disagree about what changing it invalidates.
 *
 * Applied on tap, with no confirm step. The setting is cheap to reverse — the sheet
 * is right there and the other office is one tap away — and a sheet that makes you
 * press Save to change one radio is a sheet that gets dismissed with the change lost.
 * This matches the visibility sheet beside it (FR-5.6), which behaves the same way.
 */

import { Text } from "react-native";

import { Sheet } from "@/components/Sheet";
import { SiteOption } from "@/components/SiteOption";
import type { Site } from "@/lib/api";
import { spacing, type, useThemedStyles, type Theme } from "@/lib/theme";

export function HomeSiteSheet({
  visible,
  sites,
  value,
  busy,
  onChange,
  onClose,
}: {
  visible: boolean;
  sites: Site[];
  /** The site currently recorded, or null for somebody who has never been asked. */
  value: string | null;
  busy: boolean;
  onChange: (siteId: string) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <Sheet visible={visible} onClose={onClose} title="Your home office">
      <Text style={styles.lede}>
        The office the app opens on. You can still book a desk at any of them.
      </Text>
      {sites.map((site) => (
        <SiteOption
          key={site.id}
          site={site}
          selected={site.id === value}
          disabled={busy}
          onPress={() => onChange(site.id)}
        />
      ))}
    </Sheet>
  );
}

const makeStyles = (t: Theme) => ({
  lede: { ...type.sub, color: t.color.muted, marginBottom: spacing(0.5) },
});
