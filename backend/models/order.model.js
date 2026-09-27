import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema(
    {
        razorpayOrderId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        amount: {
            type: Number,
            required: true
        },
        currency: {
            type: String,
            default: 'INR'
        },
        receipt: {
            type: String
        },
        status: {
            type: String,
            enum: ['created', 'paid', 'failed'],
            default: 'created'
        },
        paymentId: {
            type: String
        }
    },
    { timestamps: true }
);

const Order = mongoose.model('Order', orderSchema);

export default Order;
