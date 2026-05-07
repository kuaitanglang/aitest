import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  try {
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: '数据库连接未配置，请检查环境变量' },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '10');
    const searchTerm = searchParams.get('search') || '';
    const searchField = searchParams.get('searchField') || 'externalCode';
    const startDate = searchParams.get('startDate') || '';
    const endDate = searchParams.get('endDate') || '';

    let query = supabase
      .from('orders')
      .select('*', { count: 'exact' });

    if (startDate) {
      query = query.gte('created_at', `${startDate}T00:00:00`);
    }
    if (endDate) {
      query = query.lte('created_at', `${endDate}T23:59:59`);
    }

    if (searchTerm) {
      if (searchField === 'createdAt') {
        query = query.ilike('created_at', `%${searchTerm}%`);
      } else {
        const fieldMap: Record<string, string> = {
          externalCode: 'external_code',
          senderName: 'sender_name',
          receiverName: 'receiver_name',
        };
        const dbField = fieldMap[searchField] || searchField;
        query = query.ilike(dbField, `%${searchTerm}%`);
      }
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      console.error('Query orders error:', error);
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        list: (data || []).map((d) => ({
          id: d.id,
          externalCode: d.external_code || '',
          senderName: d.sender_name || '',
          senderPhone: d.sender_phone || '',
          senderAddress: d.sender_address || '',
          receiverName: d.receiver_name || '',
          receiverPhone: d.receiver_phone || '',
          receiverAddress: d.receiver_address || '',
          weight: String(d.weight || ''),
          quantity: String(d.quantity || ''),
          temperature: d.temperature || '',
          remark: d.remark || '',
          createdAt: d.created_at,
        })),
        pagination: {
          page,
          pageSize,
          total: count || 0,
          totalPages: Math.ceil((count || 0) / pageSize),
        },
      },
    });

  } catch (error) {
    console.error('Get orders error:', error);
    return NextResponse.json(
      { success: false, error: '服务器内部错误' },
      { status: 500 }
    );
  }
}