/**
 * The building, at the top of the home screen (FR-2.1).
 *
 * Two jobs, and the second is the one worth writing down. It shows the office you are
 * walking into — but it also has to hold its shape before the photo arrives and when
 * there is no photo at all, because a header that grows by 160pt on load shoves the
 * day's booking down the screen just as somebody is reaching for it. So the box is
 * sized from `aspect_ratio`, which the API sends with the URL for exactly this reason,
 * and the fallback occupies the same box rather than collapsing.
 *
 * The fallback is deliberately not a stock photograph of somebody else's office. It is
 * the site's own name under the building glyph, on a band in the theme's own colours —
 * obviously a placeholder, obviously this product, and it costs nothing to download.
 *
 * Text is NOT drawn over the photo. A scrim tuned against one customer's glass atrium
 * is unreadable over another's red brick, and there is no way to check every tenant's
 * building. The greeting sits underneath, on the ground, where contrast is ours.
 */

import { useState } from "react";
import { Image, Text, View } from "react-native";

import { Icon } from "@/components/Icon";
import type { SitePhoto } from "@/lib/api";
import { radius, spacing, type, useTheme, useThemedStyles, type Theme } from "@/lib/theme";

/** Tall enough to read as a photograph, short enough to leave the hero card above the
 *  fold on a 667pt iPhone SE. */
const MAX_HEIGHT = 168;
const MIN_HEIGHT = 112;

export function SiteBanner({
  photo,
  siteName,
  width,
}: {
  photo: SitePhoto | null | undefined;
  siteName: string;
  /** The content width the banner fills, so its height can follow the real ratio. */
  width: number;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  // A URL that 404s (an asset swept from storage, an expired signature) must degrade
  // to the placeholder, not to a grey rectangle with nothing in it.
  //
  // Keyed on the URL, because the photo URL carries a signed token that expires after
  // an hour (TDD §11): an app left open overnight fails once, and must then recover
  // the moment a refresh hands it a freshly signed URL. Sticky failure state would
  // leave the placeholder up until the process restarted.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = !!photo && failedUrl === photo.url;

  const ratio = photo?.aspect_ratio && photo.aspect_ratio > 0 ? photo.aspect_ratio : 16 / 9;
  const height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, width / ratio)));

  // No accessibilityRole="image" on the placeholder: it is not one, and on iOS that
  // role on a container can swallow the text inside it. The site name IS the content
  // here, and it should be read as text.
  if (!photo || failed) {
    return (
      <View style={[styles.frame, styles.placeholder, { height }]}>
        <Icon name="building" size={30} color={theme.color.accentText} />
        <Text style={styles.placeholderText} numberOfLines={1}>
          {siteName}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.frame, { height }]}>
      <Image
        source={{ uri: photo.url }}
        style={{ width: "100%", height: "100%" }}
        resizeMode="cover"
        onError={() => setFailedUrl(photo.url)}
        accessible
        accessibilityRole="image"
        accessibilityLabel={siteName}
      />
    </View>
  );
}

const makeStyles = (t: Theme) => ({
  frame: {
    marginHorizontal: spacing(2),
    borderRadius: radius.l,
    overflow: "hidden" as const,
    backgroundColor: t.color.surfaceAlt,
  },
  placeholder: {
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: spacing(0.75),
    backgroundColor: t.color.accentSoft,
  },
  placeholderText: {
    ...type.label,
    color: t.color.accentText,
    paddingHorizontal: spacing(2),
  },
});
