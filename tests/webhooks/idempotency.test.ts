import { describe, it, expect, beforeEach } from 'vitest';
import { isAlreadyProcessed, clearDeliveryCache } from '../../src/webhooks/github.js';

describe('Webhook Idempotency', () => {
  beforeEach(() => {
    clearDeliveryCache();
  });

  it('should return false for a new delivery ID', () => {
    const result = isAlreadyProcessed('delivery-001');
    expect(result).toBe(false);
  });

  it('should return true for a duplicate delivery ID', () => {
    isAlreadyProcessed('delivery-001');
    const result = isAlreadyProcessed('delivery-001');
    expect(result).toBe(true);
  });

  it('should handle multiple unique delivery IDs', () => {
    expect(isAlreadyProcessed('delivery-001')).toBe(false);
    expect(isAlreadyProcessed('delivery-002')).toBe(false);
    expect(isAlreadyProcessed('delivery-003')).toBe(false);

    // All should now be duplicates
    expect(isAlreadyProcessed('delivery-001')).toBe(true);
    expect(isAlreadyProcessed('delivery-002')).toBe(true);
    expect(isAlreadyProcessed('delivery-003')).toBe(true);
  });

  it('should clear cache when clearDeliveryCache is called', () => {
    isAlreadyProcessed('delivery-001');
    expect(isAlreadyProcessed('delivery-001')).toBe(true);

    clearDeliveryCache();

    // After clearing, the same ID should be treated as new
    expect(isAlreadyProcessed('delivery-001')).toBe(false);
  });
});
