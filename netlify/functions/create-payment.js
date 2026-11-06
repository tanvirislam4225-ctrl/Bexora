exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const { amount, name, email, phone, orderId } = JSON.parse(event.body);
    const site = process.env.URL;

    const res = await fetch('https://pay.securepaybd.xyz/api/create', {
      method: 'POST',
      headers: {
        'API-KEY': process.env.PAY_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: String(amount),
        currency: 'BDT',
        success_url: site + '/success.html',
        cancel_url: site + '/cancel.html',
        cus_name: name,
        cus_email: email,
        cus_phone: phone,
        metadata: { orderId: orderId },
        webhook_url: site + '/.netlify/functions/payment-webhook'
      })
    });

    const data = await res.json();
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Payment failed' }) };
  }
};
