import { Image, StyleSheet, View } from 'react-native';
import { colors } from '../theme';
import brandMarkPng from '../../assets/brand/mark.png';

interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 18 }: BrandMarkProps) {
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

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bgItem,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: {
    width: '80%',
    height: '80%',
  },
});
