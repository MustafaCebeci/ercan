// test/mocks/sms.js
// Mock SMS functions for testing notification.service.js

import { vi } from 'vitest';

// Track all SMS sends for assertions
export const sentSmsLog = [];

// Reset the log
export function resetSmsLog() {
  sentSmsLog.length = 0;
}

// Mock sendSms implementation
export const mockSendSms = vi.fn().mockImplementation(async ({ appointment_id, phone, message, type }) => {
  // Log the SMS for test assertions
  sentSmsLog.push({ appointment_id, phone, message, type, timestamp: Date.now() });

  // Return a successful response similar to MesajPaneliApi
  return {
    status: true,
    msg_id: `mock-msg-${Date.now()}`,
    error: null,
  };
});

// Mock sendCancellationSms implementation
export const mockSendCancellationSms = vi.fn().mockImplementation(async (appointment, closureStart, closureEnd) => {
  const customerName = appointment?.customer_name || 'musterimiz';
  const startTime = closureStart?.slice(11, 16) || '09:00';
  const endTime = closureEnd?.slice(11, 16) || '18:00';

  sentSmsLog.push({
    appointment_id: appointment?.id,
    phone: appointment?.customer_phone,
    message: `Sayın ${customerName}, randevu aldığınız personelimiz ${startTime} - ${endTime} saatleri arasında çalışmayacaktır. Daha sonrası için randevu alabilir, detaylı bilgi için işletmemizle iletişime geçebilirsiniz. İyi günler dileriz.`,
    type: 'cancellation',
    timestamp: Date.now(),
  });

  return { ok: true };
});

// Mock sendMail implementation
export const mockSendMail = vi.fn().mockResolvedValue({ accepted: ['test@example.com'] });

// Helper to get last SMS sent to a specific phone
export function getLastSmsToPhone(phone) {
  return sentSmsLog.filter(s => s.phone === phone).pop();
}

// Helper to get all SMS sent for an appointment
export function getSmsForAppointment(appointmentId) {
  return sentSmsLog.filter(s => s.appointment_id === appointmentId);
}

// Mock OTP functions
export const mockGenerateOtpCode = vi.fn().mockReturnValue('123456');
export const mockSha256 = vi.fn().mockReturnValue('mocked-hash');