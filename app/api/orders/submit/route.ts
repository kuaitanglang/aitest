import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { OrderItem, OrderItemField } from '@/types';
import { validateOrderItem } from '@/lib/excel';

export async function POST(request: NextRequest) {
  try {
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: '数据库连接未配置，请检查环境变量' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const items: OrderItem[] = body.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { success: false, error: '请提供有效的订单记录' },
        { status: 400 }
      );
    }

    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      
      const validationErrors = validateOrderItem(item);
      if (validationErrors.length > 0) {
        failed++;
        errors.push(`第${i + 1}行: ${validationErrors.map(e => e.message).join('; ')}`);
        continue;
      }

      try {
        const { error: dbError } = await supabase.from('orders').insert({
          external_code: item.externalCode?.trim() || null,
          sender_name: item.senderName?.trim() || '',
          sender_phone: item.senderPhone?.trim() || '',
          sender_address: item.senderAddress?.trim() || '',
          receiver_name: item.receiverName?.trim() || '',
          receiver_phone: item.receiverPhone?.trim() || '',
          receiver_address: item.receiverAddress?.trim() || '',
          weight: parseFloat(item.weight) || 0,
          quantity: parseInt(item.quantity, 10) || 0,
          temperature: item.temperature?.trim() || '',
          remark: item.remark?.trim() || '',
        });

        if (dbError) {
          failed++;
          errors.push(`第${i + 1}行: 数据库写入失败 - ${dbError.message}`);
        } else {
          success++;
        }
      } catch (err) {
        failed++;
        errors.push(`第${i + 1}行: 处理异常`);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        total: items.length,
        success,
        failed,
        errors: errors.length > 0 ? errors : undefined,
      }
    });

  } catch (error) {
    console.error('Submit orders error:', error);
    return NextResponse.json(
      { success: false, error: '服务器内部错误' },
      { status: 500 }
    );
  }
}