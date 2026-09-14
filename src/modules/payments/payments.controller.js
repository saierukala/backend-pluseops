import { PaymentService } from './payments.service.js';

const paymentService = new PaymentService();

export async function createPayment(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const payment = await paymentService.create(tenantId, userId, req.body);
    res.status(201).json({ success: true, data: payment, message: 'Payment created successfully' });
  } catch (error) { next(error); }
}

export async function confirmPayment(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const payment = await paymentService.confirm(tenantId, userId, req.body);
    res.status(200).json({ success: true, data: payment, message: 'Payment confirmed successfully' });
  } catch (error) { next(error); }
}

export async function webhookHandler(req, res, next) {
  try {
    const signature = req.headers['x-webhook-signature'] || req.headers['x-payment-signature'];
    const result = await paymentService.handleWebhook(req.body, req.headers, signature);
    res.status(200).json({ success: true, data: result.payment, duplicate: result.duplicate, message: result.duplicate ? 'Webhook already processed' : 'Webhook processed' });
  } catch (error) { next(error); }
}

export async function getPayment(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const payment = await paymentService.getById(id, tenantId);
    res.status(200).json({ success: true, data: payment, message: 'Payment retrieved successfully' });
  } catch (error) { next(error); }
}

export async function refundPayment(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const { id } = req.params;
    const payment = await paymentService.refund(tenantId, userId, id, req.body);
    res.status(200).json({ success: true, data: payment, message: 'Refund processed successfully' });
  } catch (error) { next(error); }
}
