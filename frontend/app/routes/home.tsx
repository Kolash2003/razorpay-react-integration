import { useState } from "react";
import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Razorpay Payment" },
    { name: "description", content: "Simple Razorpay payment page" },
  ];
}

declare global {
  interface Window {
    Razorpay: any;
  }
}

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

type Status = { type: "idle" | "success" | "error"; message: string };

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) {
    throw new Error(
      "No response from the server. Make sure the backend and MongoDB are running.",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The server returned an invalid response.");
  }
}

export default function Home() {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Status>({ type: "idle", message: "" });

  async function handlePay(e: React.FormEvent) {
    e.preventDefault();

    const rupees = Number(amount);
    if (!rupees || rupees <= 0) {
      setStatus({ type: "error", message: "Enter a valid amount in rupees." });
      return;
    }

    setLoading(true);
    setStatus({ type: "idle", message: "" });

    try {
      const loaded = await loadRazorpayScript();
      if (!loaded) {
        throw new Error("Failed to load Razorpay checkout. Check your connection.");
      }

      const orderRes = await fetch("/api/payment/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: rupees }),
      });
      const order = await readJson(orderRes);

      if (!orderRes.ok || !order.success) {
        throw new Error(order.message || "Could not create order.");
      }

      const keyId = import.meta.env.VITE_RAZORPAY_KEY_ID;
      if (!keyId) {
        throw new Error("Razorpay key id is not configured.");
      }

      const razorpay = new window.Razorpay({
        key: keyId,
        amount: order.amount,
        currency: order.currency,
        name: "Test Store",
        description: `Payment of ₹${rupees}`,
        order_id: order.id,
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          try {
            const verifyRes = await fetch("/api/payment/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });
            const verified = await readJson(verifyRes);

            if (!verifyRes.ok || !verified.success) {
              throw new Error(verified.message || "Verification failed.");
            }

            setStatus({
              type: "success",
              message: `Payment successful. Payment ID: ${response.razorpay_payment_id}`,
            });
          } catch (err) {
            setStatus({
              type: "error",
              message:
                err instanceof Error ? err.message : "Payment verification failed.",
            });
          } finally {
            setLoading(false);
          }
        },
        modal: {
          ondismiss: () => {
            setLoading(false);
            setStatus({ type: "error", message: "Payment cancelled." });
          },
        },
        theme: { color: "#4f46e5" },
      });

      razorpay.on("payment.failed", (response: any) => {
        setLoading(false);
        setStatus({
          type: "error",
          message:
            response?.error?.description || "Payment failed. Please try again.",
        });
      });

      razorpay.open();
    } catch (err) {
      setLoading(false);
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-800 p-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          Make a Payment
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Enter an amount in rupees to pay via Razorpay.
        </p>

        <form onSubmit={handlePay} className="mt-6 space-y-4">
          <div>
            <label
              htmlFor="amount"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Amount (₹)
            </label>
            <div className="mt-1 flex rounded-lg border border-gray-300 dark:border-gray-700 focus-within:ring-2 focus-within:ring-indigo-500 overflow-hidden">
              <span className="flex items-center px-3 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-sm">
                ₹
              </span>
              <input
                id="amount"
                type="number"
                min="1"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="500"
                className="flex-1 px-3 py-2 bg-transparent text-gray-900 dark:text-gray-100 outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed transition"
          >
            {loading ? "Processing…" : "Pay Now"}
          </button>
        </form>

        {status.message && (
          <p
            className={`mt-4 text-sm rounded-lg px-3 py-2 ${
              status.type === "success"
                ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400"
                : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400"
            }`}
          >
            {status.message}
          </p>
        )}
      </div>
    </main>
  );
}
