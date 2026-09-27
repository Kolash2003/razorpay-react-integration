import mongoose from 'mongoose';

export async function connectDB() {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/razorpay_test';

    try {
        await mongoose.connect(uri);
        console.log('MongoDB connected');
    } catch (error) {
        console.error('MongoDB connection error', error);
        throw error;
    }
}

export default connectDB;
