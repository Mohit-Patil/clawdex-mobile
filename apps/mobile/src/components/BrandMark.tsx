import { useMemo } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useAppTheme, type AppTheme } from '../theme';
import brandMarkPng from '../../assets/brand/mark.png';

interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 18 }: BrandMarkProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.28),
        },
      ]}
    >
      <Image
        source={brandMarkPng}
        resizeMode="contain"
        style={styles.image}
      />
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.isDark ? theme.colors.bgItem : theme.colors.textPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.isDark ? theme.colors.borderLight : 'rgba(255, 255, 255, 0.16)',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    image: {
      width: '80%',
      height: '80%',
    },
  });
