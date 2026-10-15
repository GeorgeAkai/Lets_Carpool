import { describe, expect, it } from 'vitest'
import { formatPlace } from './places'

describe('formatPlace', () => {
  it('drops repeated city names and abbreviates US states', () => {
    expect(formatPlace('Chico, Chico, California')).toBe('Chico, CA')
  })

  it('drops postcodes, counties and the country', () => {
    expect(formatPlace('Chico State, Chico, California, 95929, United States')).toBe('Chico State, Chico, CA')
    expect(formatPlace('Sacramento International Airport, Sacramento, Sacramento County, California, United States'))
      .toBe('Sacramento International Airport, Sacramento, CA')
  })

  it('leaves already-short labels alone', () => {
    expect(formatPlace('San Francisco, CA')).toBe('San Francisco, CA')
    expect(formatPlace('Logan Airport')).toBe('Logan Airport')
    expect(formatPlace('')).toBe('')
  })
})
