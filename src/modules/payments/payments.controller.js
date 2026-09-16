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
    // Phase 15: validate signature synchronously before enqueueing (do not weaken verification)
    const { verifyWebhookSignature } = await import('./webhook.util.js');
    const headerSig = signature || req.headers['x-webhook-signature'] || req.headers['x-payment-signature'];
    const isValidSig = verifyWebhookSignature(req.body, headerSig);
    if (!headerSig || !isValidSig) {
      const { AppError } = await import('../../common/errors/app-error.js');
      throw new AppError('Invalid webhook signature', { statusCode: 401, code: 'INVALID_WEBHOOK_SIGNATURE' });
    }
    // Enqueue to BullMQ for async processing; HTTP does not wait for slow DB work
    // Fallback to synchronous processing if Redis/BullMQ unavailable
    const { enqueueWebhook } = await import('../../jobs/queues/webhook.queue.js');
    const eventId = req.body?.eventId;
    const job = await enqueueWebhook({
      tenantId: req.body?.tenantId || null,
      eventId,
      payload: req.body,
      headers: req.headers,
      signature: headerSig,
    });
    if (job?.fallback) {
      const result = job.result;
      res.status(200).json({ success: true, data: result.payment, duplicate: result.duplicate, message: result.duplicate ? 'Webhook already processed' : 'Webhook processed' });
      return;
    }
    if (job?.duplicate) {
      res.status(202).json({ success: true, data: null, enqueued: true, duplicate: true, message: 'Webhook already enqueued (idempotent)' });
      return;
    }
    res.status(202).json({ success: true, data: null, enqueued: true, jobId: job.id, message: 'Webhook enqueued for processing' });
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
