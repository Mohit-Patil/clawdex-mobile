import {
  AUTO_STORE_REVIEW_THRESHOLD_MS,
  createDefaultAutoStoreReviewState,
  isAutoStoreReviewEligible,
  parseAutoStoreReviewState,
} from '../storeReview';

describe('storeReview helpers', () => {
  it('defaults invalid payloads to an unused review state', () => {
    expect(parseAutoStoreReviewState('')).toEqual(createDefaultAutoStoreReviewState());
    expect(parseAutoStoreReviewState('{')).toEqual(createDefaultAutoStoreReviewState());
  });

  it('normalizes persisted review prompt state', () => {
    expect(
      parseAutoStoreReviewState(
        JSON.stringify({
          accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS + 2500.9,
          automaticRequestAt: ' 2026-03-31T12:00:00.000Z ',
        })
      )
    ).toEqual({
      accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS + 2500,
      automaticRequestAt: '2026-03-31T12:00:00.000Z',
    });
  });

  it('becomes eligible after the active-use threshold until an automatic request is recorded', () => {
    expect(
      isAutoStoreReviewEligible({
        accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS - 1,
        automaticRequestAt: null,
      })
    ).toBe(false);

    expect(
      isAutoStoreReviewEligible({
        accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS,
        automaticRequestAt: null,
      })
    ).toBe(true);

    expect(
      isAutoStoreReviewEligible({
        accumulatedForegroundMs: AUTO_STORE_REVIEW_THRESHOLD_MS * 2,
        automaticRequestAt: '2026-03-31T12:00:00.000Z',
      })
    ).toBe(false);
  });
});
