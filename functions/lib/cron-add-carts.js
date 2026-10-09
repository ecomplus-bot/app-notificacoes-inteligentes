const { logger } = require('firebase-functions')
const axios = require('axios')
const { firestore } = require('firebase-admin')

const MAX_ATTEMPTS = 3
// carts stuck in queue for too long must not be notified anymore
const MAX_DELAY_MS = 24 * 60 * 60 * 1000

const processCart = async ({ appSdk }, doc, i) => {
  const { storeId, data, url, sendAt } = doc.data()
  console.log(storeId, url)
  const cartId = doc.ref.id
  console.log('cart id', cartId)
  if (sendAt && Date.now() - sendAt.toDate().getTime() > MAX_DELAY_MS) {
    logger.warn(`skipping stale cart ${cartId} for #${storeId}`, { sendAt: sendAt.toDate() })
    await doc.ref.delete()
    return
  }

  let cart
  try {
    cart = (await appSdk.apiRequest(storeId, `/carts/${cartId}.json`)).response.data
  } catch (error) {
    const status = error.response && error.response.status
    if (status > 400 && status < 500) {
      logger.warn(`failed reading cart ${cartId} for #${storeId}`, {
        status,
        response: error.response && error.response.data
      })
    } else {
      throw error
    }
  }

  if (cart && !cart.completed) {
    console.log('cart before send', cart.items && cart.items.length, 'index:', i)
    data.cart = cart
    const { status, data: resData } = await axios({
      method: 'post',
      url,
      data,
      timeout: 20000
    })
    console.log(`> ${status}`, JSON.stringify(resData))
  }
  console.log('index after delete', i, storeId)
  await doc.ref.delete()
}

module.exports = async ({ appSdk }) => {
  const d = new Date()
  const snapshot = await firestore().collection('cart_to_add')
    .where('sendAt', '<=', d)
    .orderBy('sendAt')
    .get()
  const { docs } = snapshot
  logger.info(`${docs.length} carts to add`)

  for (let i = 0; i < docs.length; i++) {
    // one failing cart must not block the whole queue
    try {
      await processCart({ appSdk }, docs[i], i)
    } catch (error) {
      const { storeId } = docs[i].data()
      const attempts = (docs[i].data().attempts || 0) + 1
      logger.error(`failed adding cart ${docs[i].ref.id} for #${storeId} (attempt ${attempts})`, {
        message: error.message,
        status: error.response && error.response.status,
        response: error.response && error.response.data
      })
      try {
        if (attempts >= MAX_ATTEMPTS) {
          await docs[i].ref.delete()
        } else {
          await docs[i].ref.update({ attempts })
        }
      } catch (err) {
        logger.error(err)
      }
    }
  }
}
