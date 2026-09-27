import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
    {
        razorpayPaymentId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        razorpayOrderId: {
            type: String,
            index: true
        },
        order: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order'
        },
        amount: {
            type: Number
        },
        currency: {
            type: String,
            default: 'INR'
        },
        status: {
            type: String,
            enum: ['created', 'captured', 'failed'],
            default: 'created'
        },
        method: {
            type: String
        },
        email: {
            type: String
        },
        contact: {
            type: String
        },
        signature: {
            type: String
        },
        event: {
            type: String
        },
        raw: {
            type: mongoose.Schema.Types.Mixed
        }
    },
    { timestamps: true }
);

const Payment = mongoose.model('Payment', paymentSchema);

export default Payment;
