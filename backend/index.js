import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import instance from './razorpayConfig/razorpayCongfig.js';
import connectDB from './config/db.js';
import Order from './models/order.model.js';
import Payment from './models/payment.model.js';

dotenv.config();
const app = express();

const PORT = process.env.PORT || 3000;
export const RAZORPAY_ID = process.env.RAZORPAY_KEY_ID;
export const RAZORPAY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const CURRENCY = process.env.CURRENCY || 'INR';
const RECEIPT_SECRET = process.env.RECEIPT_SECRET || 'something';

function safeCompare(a = '', b = '') {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// Webhook must use the raw body for signature verification, so it is
// registered before the JSON body parser.
app.post(
    '/api/payment/webhook',
    express.raw({ type: 'application/json' }),
    capturePaymentController
);

app.use(express.json());

const paymentRouter = express.Router();

paymentRouter.post('/order', createOrderController);
paymentRouter.post('/verify', verifyPaymentController);

app.use('/api/payment', paymentRouter);

export async function createOrderController(req, res) {
    try {
        const amount = Number(req.body?.amount);

        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'A valid amount in rupees is required'
            });
        }

        const options = {
            amount: Math.round(amount * 100),
            currency: CURRENCY,
            receipt: RECEIPT_SECRET
        };

        const orders = await instance.orders.create(options);

        if (!orders) {
            throw new Error('Failed to create order');
        }

        await Order.create({
            razorpayOrderId: orders.id,
            amount: orders.amount,
            currency: orders.currency,
            receipt: RECEIPT_SECRET,
            status: 'created'
        });

        return res.status(201).json({
            success: true,
            message: 'new order created successfully',
            id: orders.id,
            currency: orders.currency,
            amount: orders.amount
        });
    } catch (error) {
        console.log('error in creating controller', error);
        return res.status(500).json({
            success: false,
            message: 'error occured in controller'
        });
    }
}

// Called by the browser after Checkout succeeds. Verifies the checkout
// signature and marks the order as paid.
export async function verifyPaymentController(req, res) {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({
                success: false,
                message: 'Missing payment verification fields'
            });
        }

        const expectedSignature = crypto
            .createHmac('sha256', RAZORPAY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (!safeCompare(expectedSignature, razorpay_signature)) {
            return res.status(400).json({
                success: false,
                message: 'Payment verification failed'
            });
        }

        const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });

        if (order) {
            order.status = 'paid';
            order.paymentId = razorpay_payment_id;
            await order.save();
        }

        await Payment.findOneAndUpdate(
            { razorpayPaymentId: razorpay_payment_id },
            {
                razorpayPaymentId: razorpay_payment_id,
                razorpayOrderId: razorpay_order_id,
                order: order?._id,
                amount: order?.amount,
                currency: order?.currency,
                status: 'captured',
                signature: razorpay_signature,
                event: 'checkout.verify'
            },
            { upsert: true, returnDocument: 'after' }
        );

        return res.status(200).json({
            success: true,
            message: 'Payment verified successfully'
        });
    } catch (error) {
        console.log('error in verify controller', error);
        return res.status(500).json({
            success: false,
            message: 'error occured while verifying payment'
        });
    }
}

// Server-to-server Razorpay webhook. Authoritative payment status.
export async function capturePaymentController(req, res) {
    try {
        const signature = req.headers['x-razorpay-signature'];

        if (!signature) {
            return res.status(400).json({
                success: false,
                message: 'Missing webhook signature'
            });
        }

        if (!RAZORPAY_WEBHOOK_SECRET) {
            console.log('RAZORPAY_WEBHOOK_SECRET is not configured');
            return res.status(500).json({
                success: false,
                message: 'Webhook secret not configured'
            });
        }

        const expectedSignature = crypto
            .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
            .update(req.body)
            .digest('hex');

        if (!safeCompare(expectedSignature, signature)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid webhook signature'
            });
        }

        const event = JSON.parse(req.body.toString());

        switch (event.event) {
            case 'payment.captured': {
                const entity = event.payload?.payment?.entity ?? {};
                const order = await Order.findOne({ razorpayOrderId: entity.order_id });

                if (order) {
                    order.status = 'paid';
                    order.paymentId = entity.id;
                    await order.save();
                }

                await Payment.findOneAndUpdate(
                    { razorpayPaymentId: entity.id },
                    {
                        razorpayPaymentId: entity.id,
                        razorpayOrderId: entity.order_id,
                        order: order?._id,
                        amount: entity.amount,
                        currency: entity.currency,
                        status: 'captured',
                        method: entity.method,
                        email: entity.email,
                        contact: entity.contact,
                        event: event.event,
                        raw: entity
                    },
                    { upsert: true, returnDocument: 'after' }
                );
                break;
            }
            case 'payment.failed': {
                const entity = event.payload?.payment?.entity ?? {};
                const order = await Order.findOne({ razorpayOrderId: entity.order_id });

                if (order) {
                    order.status = 'failed';
                    await order.save();
                }

                await Payment.findOneAndUpdate(
                    { razorpayPaymentId: entity.id },
                    {
                        razorpayPaymentId: entity.id,
                        razorpayOrderId: entity.order_id,
                        order: order?._id,
                        amount: entity.amount,
                        currency: entity.currency,
                        status: 'failed',
                        method: entity.method,
                        email: entity.email,
                        contact: entity.contact,
                        event: event.event,
                        raw: entity
                    },
                    { upsert: true, returnDocument: 'after' }
                );
                break;
            }
            case 'order.paid': {
                const entity = event.payload?.order?.entity ?? {};
                await Order.findOneAndUpdate(
                    { razorpayOrderId: entity.id },
                    { status: 'paid' }
                );
                break;
            }
            default:
                console.log(`Unhandled Razorpay webhook event: ${event.event}`);
        }

        return res.status(200).json({ success: true, message: 'Webhook received' });
    } catch (error) {
        console.log('error in capture webhook controller', error);
        return res.status(500).json({
            success: false,
            message: 'error occured while handling webhook'
        });
    }
}

connectDB()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`server running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error('failed to start server', error);
        process.exit(1);
    });
