console.log('config loading')
await new Promise((resolve) => setTimeout(resolve, 30_000))
throw new Error('Config evaluation continued after shutdown')
