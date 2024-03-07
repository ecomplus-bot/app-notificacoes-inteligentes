const axios = require('axios')

// read configured E-Com Plus app data
const getAppData = require('./../../lib/store-api/get-app-data')

const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'

exports.post = ({ appSdk }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body

  // get app configured options
  getAppData({ appSdk, storeId })

    .then(appData => {
      if (
        Array.isArray(appData.ignore_triggers) &&
        appData.ignore_triggers.indexOf(trigger.resource) > -1
      ) {
        // ignore current trigger
        const err = new Error()
        err.name = SKIP_TRIGGER_NAME
        throw err
      }

      /* DO YOUR CUSTOM STUFF HERE */
      const { resource } = trigger
      if ((resource === 'orders' || resource === 'carts') && trigger.action !== 'delete') {
        const resourceId = trigger.resource_id || trigger.inserted_id
        if (resourceId) {
          const url = appData.ni_webhook_uri
          console.log(`Trigger for Store #${storeId} ${resourceId} => ${url}`)
          if (url) {
            return appSdk.apiRequest(storeId, `${resource}/${resourceId}.json`)
              .then(async ({ response }) => {
                let customer
                if (resource === 'carts') {
                  const cart = response.data
                  if (cart.available && !cart.completed) {
                    const abandonedCartDelay = (appData.cart_delay || 12) * 1000 * 60
                    const { customers } = cart
                    if (customers && customers[0]) {
                      const { response } = await appSdk.apiRequest(storeId, `customers/${customers[0]}.json`)
                      customer = response.data
                    }
                    if (!(Date.now() - new Date(cart.created_at).getTime() >= abandonedCartDelay)) {
                      const documentRef = firestore().doc(`cart_to_add/${cart._id}`)
                      const msDate = new Date(cart.created_at).getTime() + abandonedCartDelay
                      await documentRef.set({
                        data: {
                          storeId,
                          trigger,
                          [resource.slice(0, -1)]: cart,
                          customer
                        },
                        url,
                        storeId,
                        sendAt: firestore.Timestamp.fromDate(new Date(msDate))
                      })
                      return res.send({
                        status: 400,
                        text: 'Waiting to send'
                      })
                    }
                  } else {
                    return res.sendStatus(204)
                  }
                }
                if (resource === 'orders' && response.data.status === 'cancelled' && !(response.data.transactions && response.data.transactions.length)) {
                  response.data.financial_status = {
                    current: 'voided'
                  }
                } else if (
                  resource === 'orders' &&
                  !trigger.fields.includes('financial_status') &&
                  !trigger.fields.includes('fulfillment_status')
                ) {
                  return res.sendStatus(204)
                }
                console.log(`> Sending ${resource} notification`)
                return axios({
                  method: 'post',
                  url,
                  data: {
                    storeId,
                    trigger,
                    [resource.slice(0, -1)]: response.data,
                    customer
                  }
                })
              })
              .then(({ status }) => console.log(`> ${status}`))
              .catch(console.error)
              .finally(() => {
                if (!res.headersSent) {
                  // all done
                  res.send(ECHO_SUCCESS)
                }
              })
          }
        }
      }
      res.sendStatus(202)
    })

    .catch(err => {
      if (err.name === SKIP_TRIGGER_NAME) {
        // trigger ignored by app configuration
        res.send(ECHO_SKIP)
      } else if (err.appWithoutAuth === true) {
        const msg = `Webhook for ${storeId} unhandled without authentication found`
        const error = new Error(msg)
        error.trigger = JSON.stringify(trigger)
        console.error(error)
        res.send(msg)
      } else {
        // console.error(err)
        // request to Store API with error response
        // return error status code
        res.status(500)
        const { message } = err
        res.send({
          error: ECHO_API_ERROR,
          message
        })
      }
    })
}
