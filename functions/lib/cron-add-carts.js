const { logger } = require('firebase-functions')
const axios = require('axios')
const { firestore } = require('firebase-admin')

const MAX_ATTEMPTS = 3
// carts stuck in queue for too long must not be notified anymore
const MAX_DELAY_MS = 24 * 60 * 60 * 1000
// order created shortly before the cart means the customer already bought with another cart
const ORDER_BEFORE_CART_MS = 60 * 60 * 1000
// avoid notifying the same customer for multiple carts
const NOTIFIED_INTERVAL_MS = 24 * 60 * 60 * 1000

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
    const customerId = cart.customers && cart.customers[0]
    if (customerId) {
      // customer may have bought with another cart (just before or after this one)
      const since = new Date(new Date(cart.created_at).getTime() - ORDER_BEFORE_CART_MS)
      const { result: orders } = (await appSdk.apiRequest(
        storeId,
        `/orders.json?buyers._id=${customerId}&created_at>=${since.toISOString()}&fields=_id&limit=1`
      )).response.data
      if (orders && orders.length) {
        console.log(`skipping cart ${cartId} for #${storeId}: customer has order ${orders[0]._id}`)
        await doc.ref.delete()
        return
      }

      // only one abandoned cart notification per customer in a while
      const notifiedRef = firestore().doc(`cart_notified/${storeId}_${customerId}`)
      const notified = await notifiedRef.get()
      if (
        notified.exists &&
        Date.now() - notified.get('sentAt').toDate().getTime() < NOTIFIED_INTERVAL_MS
      ) {
        console.log(`skipping cart ${cartId} for #${storeId}: customer already notified with cart ${notified.get('cartId')}`)
        await doc.ref.delete()
        return
      }
    }

    console.log('cart before send', cart.items && cart.items.length, 'index:', i)
    data.cart = cart
    const { status, data: resData } = await axios({
      method: 'post',
      url,
      data,
      timeout: 20000
    })
    console.log(`> ${status}`, JSON.stringify(resData))
    if (customerId) {
      await firestore().doc(`cart_notified/${storeId}_${customerId}`).set({
        storeId,
        cartId,
        sentAt: firestore.Timestamp.now()
      }).catch(logger.error)
    }
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
      const { storeId, attempts: prevAttempts = 0 } = docs[i].data()
      const attempts = prevAttempts + 1
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
