/**
 * Bottom sheet.
 *
 * It exists because `Alert.alert` was carrying work it cannot do. An alert is a dead
 * end by construction: one line of text and a dismiss button. Every refusal this app
 * produces arrives with a machine-readable reason and enough context to offer a way
 * forward (TDD §11), and none of that fits in an alert — so the alert threw it away
 * and the user was left to guess another day and try again.
 *
 * Built on `Modal` rather than a gesture-driven pan sheet on purpose. A pan handler
 * would mean worklets, and anything a gesture handler calls in this app has to carry
 * the `"worklet"` directive or the process aborts with no JS error — a trap already
 * paid for once. There is nothing here a drag would buy that the backdrop and the
 * hardware back button do not.
 */

import { useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { spacing, type, useThemedStyles, type Theme } from "@/lib/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Read aloud when the sheet opens; also the visible heading when `title` is shown. */
  title: string;
  /** Hide the heading when the content supplies its own. The label still announces. */
  showTitle?: boolean;
  children: ReactNode;
};

export function Sheet({ visible, onClose, title, showTitle = true, children }: Props) {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      slide.setValue(0);
      return;
    }
    Animated.timing(slide, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdropWrap}>
        {/* Tapping away is a dismissal, not a choice — so it never carries an action. */}
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom: insets.bottom + spacing(2),
              maxHeight: height * 0.82,
              transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [320, 0] }) }],
            },
          ]}
          accessibilityViewIsModal
          accessibilityLabel={title}
        >
          <View style={styles.grab} />
          {showTitle ? <Text style={styles.title}>{title}</Text> : null}
          <ScrollView
            bounces={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.body}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (t: Theme) => ({
  backdropWrap: { flex: 1, justifyContent: "flex-end" as const },
  backdrop: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(22,24,28,0.38)",
  },
  sheet: {
    backgroundColor: t.color.surface,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingTop: spacing(1),
    paddingHorizontal: spacing(2.5),
  },
  grab: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: t.color.line,
    alignSelf: "center" as const,
    marginBottom: spacing(1.5),
  },
  title: { ...type.title, color: t.color.ink, marginBottom: spacing(1.5) },
  body: { gap: spacing(1.5), paddingBottom: spacing(1) },
});
