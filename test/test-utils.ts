import defaultWaitForExpect from 'wait-for-expect'

export const waitForExpect =
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  defaultWaitForExpect as unknown as typeof import('wait-for-expect').default
