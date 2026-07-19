/**
 * Shopping module seed — realistic multi-vendor dataset.
 *
 * Idempotent: every entity is upserted by a stable natural key
 * (email, slug, coupon code, order odexId), so running twice never duplicates.
 *
 * Creates:
 *   - 4 brands, each owned by an approved vendor Provider, distinct themes
 *   - 6 categories per brand, 40+ products with variants and stock
 *   - 3 outlets per brand at real Lahore coordinates
 *   - 5 coupons (4 brand-scoped + 1 platform-wide)
 *   - 1 demo customer with wallet money, saved address
 *   - 12 orders covering EVERY OrderStatus incl. a return and a refund
 *   - product reviews from delivered orders
 *
 * Run: node scripts/seed-shopping.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Provider = require('../src/models/Provider');
const WalletService = require('../src/services/walletService');

const Brand = require('../src/modules/shopping/models/Brand');
const Category = require('../src/modules/shopping/models/Category');
const Product = require('../src/modules/shopping/models/Product');
const Outlet = require('../src/modules/shopping/models/Outlet');
const Coupon = require('../src/modules/shopping/models/Coupon');
const Address = require('../src/modules/shopping/models/Address');
const Order = require('../src/modules/shopping/models/Order');
const OrderGroup = require('../src/modules/shopping/models/OrderGroup');
const ReturnRequest = require('../src/modules/shopping/models/ReturnRequest');
const ProductReview = require('../src/modules/shopping/models/ProductReview');

const log = (msg) => console.log(`  ${msg}`);

const BRANDS = [
  {
    slug: 'outfitters',
    name: 'Outfitters',
    tagline: 'Wear your attitude',
    description: 'Contemporary western wear for the young and bold.',
    primaryColor: '#1A1A2E', secondaryColor: '#E67E22', accentColor: '#F1C40F',
    vendor: { email: 'vendor.outfitters@metromatrix.pk', fullName: 'Ahmed Raza', phoneNumber: '03001234501' },
    categories: ['Men', 'Women', 'Shirts', 'Denim', 'Shoes', 'Accessories'],
    productPrefix: 'OF',
  },
  {
    slug: 'khaadi',
    name: 'Khaadi Threads',
    tagline: 'Handwoven heritage',
    description: 'Eastern wear rooted in traditional Pakistani craft.',
    primaryColor: '#7B2D26', secondaryColor: '#D4A373', accentColor: '#E9C46A',
    vendor: { email: 'vendor.khaadi@metromatrix.pk', fullName: 'Fatima Malik', phoneNumber: '03001234502' },
    categories: ['Unstitched', 'Kurtas', 'Dupattas', 'Formals', 'Kids', 'Sale'],
    productPrefix: 'KT',
  },
  {
    slug: 'servis-steps',
    name: 'Servis Steps',
    tagline: 'Every step counts',
    description: 'Footwear for the whole family, work to weekend.',
    primaryColor: '#0F4C5C', secondaryColor: '#5F0F40', accentColor: '#FB8B24',
    vendor: { email: 'vendor.servis@metromatrix.pk', fullName: 'Omar Shahid', phoneNumber: '03001234503' },
    categories: ['Sneakers', 'Formal Shoes', 'Sandals', 'Joggers', 'Kids Shoes', 'Care'],
    productPrefix: 'SS',
  },
  {
    slug: 'techmart',
    name: 'TechMart',
    tagline: 'Gadgets that deliver',
    description: 'Phone accessories, audio and smart gadgets at street prices.',
    primaryColor: '#14213D', secondaryColor: '#FCA311', accentColor: '#2EC4B6',
    vendor: { email: 'vendor.techmart@metromatrix.pk', fullName: 'Sana Tariq', phoneNumber: '03001234504' },
    categories: ['Audio', 'Chargers', 'Cases', 'Smart Watches', 'Storage', 'Cables'],
    productPrefix: 'TM',
  },
];

// Real Lahore coordinates for outlets
const LAHORE_SPOTS = [
  { name: 'Gulberg', address: 'M.M. Alam Road, Gulberg III', lat: 31.5090, lng: 74.3444, postal: '54660' },
  { name: 'DHA', address: 'Y-Block Commercial, DHA Phase 3', lat: 31.4795, lng: 74.3936, postal: '54792' },
  { name: 'Emporium', address: 'Emporium Mall, Johar Town', lat: 31.4676, lng: 74.2665, postal: '54782' },
];

const PRODUCT_TEMPLATES = {
  OF: [
    ['Classic Cotton Shirt', 2999, 2499, ['S', 'M', 'L', 'XL']],
    ['Premium Denim Jacket', 6499, null, ['M', 'L', 'XL']],
    ['Slim Fit Chinos', 3499, 2999, ['30', '32', '34', '36']],
    ['Graphic Tee', 1499, 1199, ['S', 'M', 'L']],
    ['Bomber Jacket', 7999, null, ['M', 'L']],
    ['Cargo Trousers', 3999, null, ['30', '32', '34']],
    ['Oversized Hoodie', 4499, 3799, ['M', 'L', 'XL']],
    ['Canvas Belt', 1299, null, ['One Size']],
    ['Baseball Cap', 999, 799, ['One Size']],
    ['Flannel Shirt', 3299, null, ['S', 'M', 'L', 'XL']],
  ],
  KT: [
    ['Embroidered Lawn 3pc', 5999, 4999, ['Unstitched']],
    ['Printed Kurta', 2799, null, ['S', 'M', 'L']],
    ['Chiffon Dupatta', 1899, 1499, ['One Size']],
    ['Formal Raw Silk 2pc', 8999, null, ['Unstitched']],
    ['Kids Kurta Shalwar', 2299, 1899, ['4-5Y', '6-7Y', '8-9Y']],
    ['Cambric Trouser', 1599, null, ['S', 'M', 'L']],
    ['Khaddar Winter 3pc', 6499, 5499, ['Unstitched']],
    ['Velvet Shawl', 4999, null, ['One Size']],
    ['Jacquard Kurta', 3999, 3499, ['S', 'M', 'L', 'XL']],
    ['Festive Gharara Set', 11999, null, ['S', 'M']],
  ],
  SS: [
    ['Runner Pro Sneaker', 5999, 4999, ['40', '41', '42', '43', '44']],
    ['Oxford Formal Shoe', 6999, null, ['40', '41', '42', '43']],
    ['Comfort Sandal', 2499, 1999, ['39', '40', '41', '42']],
    ['Daily Jogger', 3999, 3499, ['40', '41', '42', '43', '44']],
    ['Kids School Shoe', 1999, null, ['30', '32', '34']],
    ['Leather Loafer', 5499, 4799, ['40', '41', '42']],
    ['Trail Hiker', 8499, null, ['41', '42', '43']],
    ['Slide Slipper', 1499, 1199, ['40', '42', '44']],
    ['Canvas Plimsoll', 2299, null, ['39', '40', '41', '42']],
    ['Shoe Care Kit', 899, null, ['One Size']],
  ],
  TM: [
    ['Wireless Earbuds X2', 4999, 3999, ['Black', 'White']],
    ['65W GaN Fast Charger', 3499, null, ['Black']],
    ['Shockproof Phone Case', 1299, 999, ['iPhone 15', 'S24', 'Pixel 8']],
    ['Smart Watch Active', 8999, 7499, ['Black', 'Rose Gold']],
    ['128GB USB-C Flash Drive', 2799, null, ['128GB']],
    ['Braided USB-C Cable 2m', 899, 699, ['Black', 'Red']],
    ['Bluetooth Speaker Mini', 3999, null, ['Black', 'Blue']],
    ['Power Bank 20000mAh', 5499, 4699, ['Black']],
    ['Ring Light 10"', 2499, null, ['White']],
    ['Car Phone Mount', 1199, 899, ['Black']],
  ],
};

const IMG = (seed) => `https://picsum.photos/seed/${seed}/600/600`;

// One canonical order per OrderStatus (plus extras) — 12 total
const ORDER_PLAN = [
  { key: 'SEED-ORD-01', status: 'pending', payment: 'cod' },
  { key: 'SEED-ORD-02', status: 'confirmed', payment: 'wallet' },
  { key: 'SEED-ORD-03', status: 'processing', payment: 'wallet' },
  { key: 'SEED-ORD-04', status: 'shipped', payment: 'cod' },
  { key: 'SEED-ORD-05', status: 'out_for_delivery', payment: 'wallet' },
  { key: 'SEED-ORD-06', status: 'delivered', payment: 'wallet' },
  { key: 'SEED-ORD-07', status: 'delivered', payment: 'cod' },
  { key: 'SEED-ORD-08', status: 'cancelled', payment: 'cod' },
  { key: 'SEED-ORD-09', status: 'returned', payment: 'wallet' },
  { key: 'SEED-ORD-10', status: 'refunded', payment: 'wallet' },
  { key: 'SEED-ORD-11', status: 'delivered', payment: 'wallet' },
  { key: 'SEED-ORD-12', status: 'pending', payment: 'wallet' },
];

const STATUS_CHAIN = {
  pending: ['pending'],
  confirmed: ['pending', 'confirmed'],
  processing: ['pending', 'confirmed', 'processing'],
  shipped: ['pending', 'confirmed', 'processing', 'shipped'],
  out_for_delivery: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery'],
  delivered: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered'],
  cancelled: ['pending', 'cancelled'],
  returned: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'returned'],
  refunded: ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'returned', 'refunded'],
};

async function upsertVendor(spec) {
  let provider = await Provider.findOne({ email: spec.email });
  if (!provider) {
    provider = await Provider.create({
      email: spec.email,
      password: 'Vendor@123',
      fullName: spec.fullName,
      phoneNumber: spec.phoneNumber,
      providerType: 'vendor',
      category: 'retail',
      emailVerified: 'active',
      adminVerified: 'active',
      isActive: true,
    });
    log(`vendor created: ${spec.email}`);
  } else {
    // Ensure the pipeline flags are right even on re-run
    provider.providerType = 'vendor';
    provider.emailVerified = 'active';
    provider.adminVerified = 'active';
    provider.isActive = true;
    await provider.save();
  }
  return provider;
}

async function upsertBrand(spec, owner) {
  let brand = await Brand.findOne({ slug: spec.slug });
  if (!brand) {
    brand = await Brand.create({
      name: spec.name,
      slug: spec.slug,
      tagline: spec.tagline,
      description: spec.description,
      logo: IMG(`${spec.slug}-logo`),
      bannerImage: IMG(`${spec.slug}-banner`),
      primaryColor: spec.primaryColor,
      secondaryColor: spec.secondaryColor,
      accentColor: spec.accentColor,
      categories: spec.categories.slice(0, 4),
      contactEmail: spec.vendor.email,
      contactPhone: `+92-42-3576${Math.floor(1000 + Math.random() * 9000)}`,
      owner: owner._id,
      status: 'active',
      approvedAt: new Date(),
    });
    log(`brand created: ${spec.name}`);
  } else if (!brand.owner) {
    brand.owner = owner._id;
    brand.status = 'active';
    await brand.save();
  }
  return brand;
}

async function upsertCategories(spec, brand) {
  const map = {};
  for (const name of spec.categories) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let cat = await Category.findOne({ brandId: brand._id, slug });
    if (!cat) {
      cat = await Category.create({ brandId: brand._id, name, slug, icon: 'tag' });
    }
    map[name] = cat;
  }
  return map;
}

async function upsertProducts(spec, brand, categories) {
  const templates = PRODUCT_TEMPLATES[spec.productPrefix];
  const catNames = spec.categories;
  const products = [];
  for (let i = 0; i < templates.length; i += 1) {
    const [name, basePrice, salePrice, sizes] = templates[i];
    const sku = `${spec.productPrefix}-${1001 + i}`;
    let product = await Product.findOne({ brandId: brand._id, sku });
    if (!product) {
      product = new Product({
        brandId: brand._id,
        categoryId: categories[catNames[i % catNames.length]]._id,
        sku,
        name,
        description: `${name} by ${spec.name}. ${spec.tagline}. Quality-checked and shipped from our Lahore warehouse.`,
        images: [IMG(`${sku}-1`), IMG(`${sku}-2`)],
        basePrice,
        salePrice: salePrice || null,
        variants: sizes.map((size, idx) => ({
          size,
          additionalPrice: 0,
          stockQuantity: 8 + ((i + idx) % 5) * 6, // 8..32, deterministic
          sku: `${sku}-${String(size).replace(/\s+/g, '')}`,
        })),
        isFeatured: i < 3,
        isNewArrival: i >= 3 && i < 6,
        tags: [spec.slug, name.split(' ')[0].toLowerCase()],
      });
      product.syncStockFlag();
      await product.save();
    }
    products.push(product);
  }
  return products;
}

async function upsertOutlets(spec, brand) {
  for (const spot of LAHORE_SPOTS) {
    const slug = `${spec.slug}-${spot.name.toLowerCase()}`;
    const exists = await Outlet.findOne({ slug });
    if (!exists) {
      await Outlet.create({
        name: `${spec.name} ${spot.name}`,
        slug,
        description: `${spec.name} outlet at ${spot.address}.`,
        brandId: brand._id,
        location: {
          address: spot.address,
          city: 'Lahore',
          state: 'Punjab',
          country: 'Pakistan',
          postalCode: spot.postal,
        },
        geo: { type: 'Point', coordinates: [spot.lng, spot.lat] },
        phone: '+92-42-35761234',
        email: `${slug}@metromatrix.pk`,
        openingHours: 'Mon–Sun: 11:00 AM – 10:00 PM',
        managerName: spec.vendor.fullName,
        images: [IMG(`${slug}-store`)],
        floorArea: 2500,
      });
    }
  }
}

async function upsertCoupons(brandsBySlug) {
  const now = Date.now();
  const day = 86400000;
  const COUPONS = [
    { couponCode: 'WELCOME10', brandId: null, type: 'percentage', value: 10, minOrderAmount: 1500, maxDiscount: 1000 },
    { couponCode: 'OUTFIT20', brandId: brandsBySlug.outfitters._id, type: 'percentage', value: 20, minOrderAmount: 5000, maxDiscount: 2500 },
    { couponCode: 'KHAADI500', brandId: brandsBySlug.khaadi._id, type: 'fixed', value: 500, minOrderAmount: 4000, maxDiscount: 0 },
    { couponCode: 'STEPS15', brandId: brandsBySlug['servis-steps']._id, type: 'percentage', value: 15, minOrderAmount: 3000, maxDiscount: 1500 },
    { couponCode: 'TECHFEST', brandId: brandsBySlug.techmart._id, type: 'percentage', value: 12, minOrderAmount: 2500, maxDiscount: 1200 },
  ];
  for (const c of COUPONS) {
    await Coupon.updateOne(
      { couponCode: c.couponCode },
      {
        $setOnInsert: {
          ...c,
          validFrom: new Date(now - 7 * day),
          validUntil: new Date(now + 60 * day),
          usageLimit: 500,
          usedCount: 0,
          isActive: true,
        },
      },
      { upsert: true }
    );
  }
  log('coupons upserted (5)');
}

async function upsertCustomer() {
  let user = await User.findOne({ email: 'customer.demo@metromatrix.pk' });
  if (!user) {
    user = await User.create({
      email: 'customer.demo@metromatrix.pk',
      password: 'Customer@123',
      fullName: 'Ayesha Khan',
      phoneNumber: '03005550001',
      isActive: true,
      isEmailVerified: true,
    });
    log('demo customer created: customer.demo@metromatrix.pk / Customer@123');
  }

  // Wallet top-up so wallet checkouts work in demos
  const wallet = await WalletService.getOrCreateWallet(user._id, 'User');
  if (wallet.balance < 50000) {
    const amount = 100000 - wallet.balance;
    await wallet.credit(amount);
    await WalletService.recordTransaction(wallet._id, {
      type: 'credit',
      amount,
      description: 'Seed top-up for shopping demo',
      source: 'admin_adjustment',
      status: 'completed',
    });
    log(`customer wallet topped up to PKR ${wallet.balance}`);
  }

  const existingAddress = await Address.findOne({ userId: user._id });
  if (!existingAddress) {
    await Address.create({
      userId: user._id,
      label: 'Home',
      fullName: user.fullName,
      phone: '03005550001',
      addressLine1: 'House 14, Street 8, Gulberg III',
      city: 'Lahore',
      area: 'Gulberg III',
      landmark: 'Near Liberty Market',
      state: 'Punjab',
      postalCode: '54660',
      isDefault: true,
    });
  }
  return user;
}

async function seedOrders(user, brands, productsByBrand) {
  const day = 86400000;
  let created = 0;

  for (let i = 0; i < ORDER_PLAN.length; i += 1) {
    const plan = ORDER_PLAN[i];
    if (await Order.findOne({ odexId: plan.key })) continue;

    const brandSpec = BRANDS[i % BRANDS.length];
    const brand = brands[brandSpec.slug];
    const products = productsByBrand[brandSpec.slug];
    const p1 = products[i % products.length];
    const p2 = products[(i + 3) % products.length];

    const lineFor = (product, qty) => {
      const variant = product.variants[0];
      const unitPrice = (product.salePrice != null ? product.salePrice : product.basePrice) + (variant.additionalPrice || 0);
      return {
        productId: product._id,
        brandId: brand._id,
        variantId: variant._id,
        productName: product.name,
        productImage: product.images[0] || '',
        variantLabel: variant.size || '',
        quantity: qty,
        unitPrice,
        totalPrice: unitPrice * qty,
      };
    };
    const items = [lineFor(p1, 1), lineFor(p2, 2)];
    const subtotal = items.reduce((s, it) => s + it.totalPrice, 0);
    const shippingFee = subtotal >= 3000 ? 0 : 150;
    const total = subtotal + shippingFee;
    const createdAt = new Date(Date.now() - (14 - i) * day);

    const isPaid = plan.payment === 'wallet' || ['delivered', 'returned'].includes(plan.status);
    const paymentStatus = plan.status === 'refunded' ? 'refunded' : isPaid ? 'paid' : 'pending';

    const group = await OrderGroup.create({
      odexId: plan.key.replace('ORD', 'GRP'),
      userId: user._id,
      orders: [],
      shippingAddress: {
        fullName: user.fullName,
        phone: '03005550001',
        addressLine1: 'House 14, Street 8, Gulberg III',
        city: 'Lahore',
        state: 'Punjab',
        postalCode: '54660',
        country: 'Pakistan',
      },
      paymentMethod: plan.payment,
      paymentStatus,
      subtotal,
      discount: 0,
      shippingFee,
      total,
      createdAt,
    });

    const chain = STATUS_CHAIN[plan.status];
    const statusHistory = chain.map((status, idx) => ({
      status,
      changedBy: {
        id: idx === 0 ? user._id : brand.owner,
        role: idx === 0 ? 'customer' : status === 'cancelled' ? 'customer' : 'vendor',
      },
      changedAt: new Date(createdAt.getTime() + idx * 6 * 60 * 60 * 1000),
    }));

    const order = await Order.create({
      odexId: plan.key,
      orderGroup: group._id,
      userId: user._id,
      brandId: brand._id,
      items,
      shippingAddress: group.shippingAddress,
      paymentMethod: plan.payment,
      paymentStatus,
      orderStatus: plan.status,
      trackingNumber: ['shipped', 'out_for_delivery', 'delivered', 'returned', 'refunded'].includes(plan.status)
        ? `TCS-${29840000 + i}`
        : null,
      subtotal,
      discount: 0,
      shippingFee,
      total,
      statusHistory,
      deliveredAt: ['delivered', 'returned', 'refunded'].includes(plan.status)
        ? new Date(createdAt.getTime() + 5 * day)
        : null,
      createdAt,
    });

    group.orders = [order._id];
    await group.save();
    created += 1;

    // Return request for the returned + refunded orders
    if (['returned', 'refunded'].includes(plan.status)) {
      await ReturnRequest.create({
        order: order._id,
        userId: user._id,
        brandId: brand._id,
        items: items.map((it) => ({
          orderItemId: order.items[0]._id,
          productId: it.productId,
          productName: it.productName,
          variantId: it.variantId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
        })),
        reason: 'Size issue: item did not fit as expected',
        status: plan.status === 'refunded' ? 'refunded' : 'requested',
        refundAmount: subtotal,
      });
    }

    // Verified-purchase review on delivered orders
    if (plan.status === 'delivered') {
      const already = await ProductReview.findOne({ productId: p1._id, userId: user._id, order: order._id });
      if (!already) {
        await ProductReview.create({
          productId: p1._id,
          brandId: brand._id,
          userId: user._id,
          order: order._id,
          rating: 4 + (i % 2),
          title: 'Happy with this purchase',
          comment: `The ${p1.name} arrived on time and matches the photos. Would order from ${brand.name} again.`,
          isVerifiedPurchase: true,
        });
        const [agg] = await ProductReview.aggregate([
          { $match: { productId: p1._id } },
          { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
        ]);
        await Product.updateOne(
          { _id: p1._id },
          { $set: { rating: Math.round((agg.avg || 0) * 10) / 10, totalReviews: agg.count || 0 } }
        );
      }
    }
  }
  log(`orders created: ${created} (skipped ${ORDER_PLAN.length - created} already present)`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n=== Shopping seed ===');

  const brands = {};
  const productsByBrand = {};
  for (const spec of BRANDS) {
    const vendor = await upsertVendor(spec.vendor);
    const brand = await upsertBrand(spec, vendor);
    const categories = await upsertCategories(spec, brand);
    productsByBrand[spec.slug] = await upsertProducts(spec, brand, categories);
    await upsertOutlets(spec, brand);
    brands[spec.slug] = brand;
  }
  log(`brands ready: ${Object.keys(brands).length}, products: ${Object.values(productsByBrand).flat().length}`);

  await upsertCoupons(brands);
  const customer = await upsertCustomer();
  await seedOrders(customer, brands, productsByBrand);

  console.log('=== Done ===');
  console.log('Demo logins:');
  console.log('  customer: customer.demo@metromatrix.pk / Customer@123');
  BRANDS.forEach((b) => console.log(`  vendor (${b.name}): ${b.vendor.email} / Vendor@123`));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
