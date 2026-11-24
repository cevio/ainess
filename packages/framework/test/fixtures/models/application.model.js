import { defineModel, defineModelOperation } from '@ainess/model'

export default defineModel('application', {
  databaseReady: defineModelOperation({
    schema: {
      '~standard': {
        version: 1,
        vendor: 'ainess-test',
        validate: () => ({ value: undefined }),
      },
    },
    inject: ['typeorm'],
    async execute(_input, _call, { typeorm }) {
      await typeorm.query('SELECT 1')
      return { ready: typeorm.isInitialized }
    },
  }),
})
