import { resolveComposerBottomSpacing } from '../chat-input-layout';

describe('resolveComposerBottomSpacing', () => {
  it('keeps a small fixed reserve for iPhones with a home indicator', () => {
    expect(resolveComposerBottomSpacing('ios', 34, false)).toEqual({
      baseBottomPadding: 6,
      extraBottomInset: 8,
      totalBottomPadding: 14,
    });
  });

  it('collapses the bottom reserve while the keyboard is visible on iOS', () => {
    expect(resolveComposerBottomSpacing('ios', 34, true)).toEqual({
      baseBottomPadding: 2,
      extraBottomInset: 0,
      totalBottomPadding: 2,
    });
  });

  it('treats Android gesture navigation as nearly flush', () => {
    expect(resolveComposerBottomSpacing('android', 8, false)).toEqual({
      baseBottomPadding: 8,
      extraBottomInset: 2,
      totalBottomPadding: 10,
    });
  });

  it('keeps extra clearance for Android phones with visible nav buttons', () => {
    expect(resolveComposerBottomSpacing('android', 24, false)).toEqual({
      baseBottomPadding: 8,
      extraBottomInset: 8,
      totalBottomPadding: 16,
    });
  });
});
