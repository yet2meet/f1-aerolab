import { describe, expect, it } from 'vitest'
import { carsForRuleset } from './cars'

describe('ruleset-specific car catalog', () => {
  it.each(['2026', '2022-2025'] as const)('only exposes %s-compatible cars', (ruleset) => {
    const compatibleCars = carsForRuleset(ruleset)

    expect(compatibleCars).toHaveLength(2)
    expect(compatibleCars.every((car) => car.ruleset === ruleset)).toBe(true)
  })
})
